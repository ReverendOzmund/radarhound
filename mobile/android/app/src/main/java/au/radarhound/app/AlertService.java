package au.radarhound.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.DateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps watching the Radarhound server for new warnings while the app is closed. Every minute it asks the
 * server's /api/alerts feed; a new warning nearby gets a heads-up notification, an attention tone and a
 * spoken announcement ("Tornado warning issued for Perth, Cannington and Bentley ..."); warnings further
 * away get a quiet notification. Tornado warnings play on the alarm stream so they are heard on silent.
 *
 * Staying awake: a handler checks every minute, and an inexact "allow while idle" alarm pokes the service
 * as a backup when Android's Doze defers the handler. While the feed lists anything (a warning or watch
 * within reach), the service holds a partial wake lock so the minute-by-minute checks keep running in
 * deep sleep; on quiet days it lets the phone sleep and checks as often as Android allows.
 */
public class AlertService extends Service implements TextToSpeech.OnInitListener {
    static final String PREFS = "radarhound_alerts";
    static final String CH_WATCH = "watch", CH_WARN = "warnings3", CH_TOR = "tornado2", CH_FAR = "further", CH_BRIEF = "brief";
    static final String ACTION_POLL = "au.radarhound.app.POLL";
    static final String GROUP_FAR = "radarhound_far";
    static final int ID_WATCH = 1;
    static final long SEEN_KEEP_MS = 12 * 3600_000L;

    private Handler handler;
    private HandlerThread thread;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private PowerManager.WakeLock wake;        // around each check
    private PowerManager.WakeLock stormWake;   // held while anything is in the feed
    private long lastCheck = 0;
    private int failures = 0;
    private long lastOk = 0;
    private String watchingText = null;
    // speech: players are kept as fields until they finish, so the garbage collector can't cut them off
    private MediaPlayer tonePlayer, voicePlayer;
    private final ArrayDeque<String[]> speechQueue = new ArrayDeque<>();   // {text, "1" if alarm stream}
    private boolean speaking = false;
    private Location lastLoc = null;
    private LocationListener locListener = null;

    static volatile AlertService instance;
    static volatile boolean pageVisible = false;

    /** Phone mode: the phone's position (when chosen and recent) or the home saved in the app. */
    private double[] phonePoint(SharedPreferences p) {
        if (useLocation() && lastLoc != null && System.currentTimeMillis() - lastLoc.getTime() < 2 * 3600_000L)
            return new double[]{lastLoc.getLatitude(), lastLoc.getLongitude()};
        if (!p.contains("homeLat")) return null;
        return new double[]{p.getFloat("homeLat", 0), p.getFloat("homeLon", 0)};
    }

    /** The backup alarm fired: check now if the minute loop has fallen behind (Doze). */
    void poke() {
        if (handler != null && System.currentTimeMillis() - lastCheck > 50_000) {
            wake.acquire(60_000);
            handler.removeCallbacks(poll);
            handler.post(poll);
        }
    }

    static void start(Context ctx) {
        Intent i = new Intent(ctx, AlertService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    @Override public void onCreate() {
        super.onCreate();
        channels();
        Notification watching = watchingNotification("Checks your server every minute");
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID_WATCH, watching, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ID_WATCH, watching);
        tts = new TextToSpeech(this, this);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "radarhound:check");
        wake.setReferenceCounted(false);
        stormWake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "radarhound:storm");
        stormWake.setReferenceCounted(false);
        thread = new HandlerThread("radarhound-alerts");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(poll);
        instance = this;
        startLocation();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_POLL.equals(intent.getAction())) poke();
        return START_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        instance = null;
        stopLocation();
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        ((AlarmManager) getSystemService(ALARM_SERVICE)).cancel(backupIntent());
        if (tts != null) tts.shutdown();
        releasePlayer(tonePlayer); releasePlayer(voicePlayer);
        if (wake != null && wake.isHeld()) wake.release();
        if (stormWake != null && stormWake.isHeld()) stormWake.release();
        super.onDestroy();
    }

    @Override public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS) {
            int r = tts.setLanguage(new Locale("en", "AU"));
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(Locale.ENGLISH);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { handler.postDelayed(AlertService.this::playNextSpeech, 400); }
                @Override public void onError(String id) { handler.post(AlertService.this::playNextSpeech); }
            });
            ttsReady = true;
        }
    }

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            wake.acquire(60_000);
            try { check(); } catch (Exception e) { checkFailed(); }
            finally {
                lastCheck = System.currentTimeMillis();
                scheduleBackup();
                handler.removeCallbacks(this);
                handler.postDelayed(this, 60_000);
                if (!speaking && wake.isHeld()) wake.release();
            }
        }
    };

    private PendingIntent backupIntent() {
        Intent i = new Intent(this, PollReceiver.class).setAction(ACTION_POLL);
        return PendingIntent.getBroadcast(this, 7, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void scheduleBackup() {
        AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
        long at = SystemClock.elapsedRealtime() + 90_000;
        if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, backupIntent());
        else am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, backupIntent());
    }

    // ---------------------------------------------------------------- the phone's own position (optional)
    private boolean useLocation() {
        return "me".equals(getSharedPreferences(PREFS, MODE_PRIVATE).getString("where", "home"));
    }

    private boolean hasLocationPermission() {
        boolean fg = checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean bg = Build.VERSION.SDK_INT < 29
            || checkSelfPermission(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        return fg && bg;
    }

    /** Network (cell/Wi-Fi) location every few minutes: cheap on battery and plenty for "where am I". */
    void startLocation() {
        if (!useLocation() || !hasLocationPermission() || locListener != null) return;
        LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        try {
            for (String prov : new String[]{LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.PASSIVE_PROVIDER}) {
                Location l = lm.getLastKnownLocation(prov);
                if (l != null && (lastLoc == null || l.getTime() > lastLoc.getTime())) lastLoc = l;
            }
            locListener = l -> lastLoc = l;
            String prov = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER : LocationManager.PASSIVE_PROVIDER;
            lm.requestLocationUpdates(prov, 5 * 60_000L, 300f, locListener, thread.getLooper());
            lm.requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, 2 * 60_000L, 200f, locListener, thread.getLooper());
        } catch (SecurityException | IllegalArgumentException e) { locListener = null; }
    }

    void stopLocation() {
        if (locListener == null) return;
        try { ((LocationManager) getSystemService(LOCATION_SERVICE)).removeUpdates(locListener); } catch (Exception ignored) { }
        locListener = null;
    }

    /** "&lat=..&lon=.." for the phone's position when that's switched on and recent, else "" (home). */
    private String pointQuery() {
        if (!useLocation()) { stopLocation(); return ""; }
        startLocation();
        if (lastLoc == null || System.currentTimeMillis() - lastLoc.getTime() > 2 * 3600_000L) return "";
        return String.format(Locale.US, "&lat=%.3f&lon=%.3f", lastLoc.getLatitude(), lastLoc.getLongitude());
    }

    private HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        String key = getSharedPreferences(PREFS, MODE_PRIVATE).getString("key", "");
        if (key != null && !key.isEmpty()) c.setRequestProperty("X-Radarhound-Key", key);
        return c;
    }

    // ---------------------------------------------------------------- quiet hours and the morning brief
    private static boolean quietNow(SharedPreferences p) {
        int f = p.getInt("quietFrom", -1), t = p.getInt("quietTo", 7);
        if (f < 0 || f == t) return false;
        int h = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
        return f < t ? (h >= f && h < t) : (h >= f || h < t);
    }

    /** Once a day at the chosen hour: today's forecast, warnings and rain as a notification, read aloud. */
    private void maybeBrief(SharedPreferences p, String server, String where) {
        int hour = p.getInt("briefHour", -1);
        if (hour < 0) return;
        java.util.Calendar cal = java.util.Calendar.getInstance();
        String today = String.format(Locale.US, "%tF", cal);
        if (cal.get(java.util.Calendar.HOUR_OF_DAY) != hour || today.equals(p.getString("briefDone", ""))) return;
        try {
            HttpURLConnection c = open(server + "/api/brief?x=1" + where);
            c.setConnectTimeout(15000); c.setReadTimeout(60000);
            StringBuilder sb = new StringBuilder();
            try {
                if (c.getResponseCode() != 200) return;
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                    String line; while ((line = r.readLine()) != null) sb.append(line);
                }
            } finally { c.disconnect(); }
            String text = new JSONObject(sb.toString()).optString("text");
            if (text.isEmpty()) return;
            p.edit().putString("briefDone", today).apply();
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_BRIEF)
                .setSmallIcon(R.drawable.ic_stat_radarhound).setContentTitle("Today's weather")
                .setContentText(text).setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true).setTimeoutAfter(6 * 3600_000L).setContentIntent(openApp());
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify("wxbrief", 2, b.build());
            if (p.getBoolean("voice", true) && !quietNow(p)) {
                wake.acquire(3 * 60_000L);
                speechQueue.add(new String[]{text, "0"});
                if (!speaking) { speaking = true; handler.postDelayed(this::playNextSpeech, 1500); }
            }
        } catch (Exception ignored) { }
    }

    private void checkFailed() {
        failures++;
        if (failures >= 3) {
            String since = lastOk > 0 ? " since " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(lastOk)) : "";
            setWatching("Can't reach your Radarhound server" + since + ". Still trying every minute.");
        }
    }

    private void check() throws Exception {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!p.getBoolean("enabled", true)) { stopSelf(); return; }
        boolean phone = "phone".equals(p.getString("mode", "server"));
        String server = p.getString("server", null);
        if (!phone && server == null) return;
        String scope = p.getString("scope", "near");
        String where = pointQuery();
        JSONArray alerts;
        if (phone) {
            // phone mode: no server, so BoM warnings and lightning straight from the source
            double[] pt = phonePoint(p);
            if (pt == null) return;
            alerts = PhoneAlerts.alerts(this, p, pt[0], pt[1]);
        } else {
            HttpURLConnection c = open(server + "/api/alerts?scope=all&near=" + p.getInt("near", 50) + where);
            c.setConnectTimeout(15000); c.setReadTimeout(20000);
            StringBuilder sb = new StringBuilder();
            try {
                if (c.getResponseCode() == 401) { setWatching("Your Radarhound server needs its password: open the app, tap ⇄ and enter it."); throw new Exception("login needed"); }
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                    String line; while ((line = r.readLine()) != null) sb.append(line);
                }
            } finally { c.disconnect(); }
            alerts = new JSONObject(sb.toString()).getJSONArray("alerts");
        }
        failures = 0; lastOk = System.currentTimeMillis();
        boolean quiet = phone && pageVisible;      // the open page alerts for itself

        // seen alerts, by "n:<id>" (announced nearby) and "f:<id>" (noted further away), with when; a
        // warning that was far away and comes closer still gets the full alert
        JSONObject seen;
        try { seen = new JSONObject(p.getString("seen2", "{}")); } catch (Exception e) { seen = new JSONObject(); }
        long now = System.currentTimeMillis();
        boolean bom = p.getBoolean("bom", true), far = p.getBoolean("far", true);
        List<JSONObject> fresh = new ArrayList<>();
        Set<Integer> current = new HashSet<>();
        for (int i = 0; i < alerts.length(); i++) {
            JSONObject a = alerts.getJSONObject(i);
            if (!bom && "BoM".equals(a.optString("source"))) continue;
            String type = a.optString("type");
            if ("LTG".equals(type) && !p.getBoolean("ltg", true)) continue;
            if ("ARR".equals(type) && !p.getBoolean("arr", true)) continue;
            if ("RAIN".equals(type) && !p.getBoolean("rain", false)) continue;
            String id = a.getString("id");
            boolean isNear = "all".equals(scope) || a.optBoolean("near", true);
            current.add(id.hashCode());
            if (!isNear) {
                if (!far || seen.has("f:" + id) || seen.has("n:" + id)) continue;
                seen.put("f:" + id, now);
                if (!quiet) notifyFar(a);
                continue;
            }
            if (seen.has("n:" + id)) continue;
            seen.put("n:" + id, now);
            if (quiet) continue;
            if (quietNow(p) && ("LTG".equals(type) || "ARR".equals(type) || "RAIN".equals(type))) { notifyFar(a); continue; }   // quiet hours
            fresh.add(a);
        }
        for (Iterator<String> it = seen.keys(); it.hasNext(); ) {
            String k = it.next();
            if (now - seen.optLong(k, 0) > SEEN_KEEP_MS) it.remove();
        }
        p.edit().putString("seen2", seen.toString()).remove("seen").apply();
        clearEnded(current);

        // the server lists nearby ones first, most severe first: tone once, then read each out (up to 3)
        if (!phone) maybeBrief(p, server, where);
        for (int i = 0; i < fresh.size(); i++) notify(fresh.get(i));
        if (!fresh.isEmpty()) announce(fresh.subList(0, Math.min(3, fresh.size())));

        // storm mode: stay awake while there's anything to watch
        int count = 0;
        for (int i = 0; i < alerts.length(); i++) if (alerts.getJSONObject(i).optInt("severity", 1) >= 1) count++;
        boolean busy = count > 0;
        if (busy) stormWake.acquire(15 * 60_000L); else if (stormWake.isHeld()) stormWake.release();
        String place = (where.isEmpty() ? "home" : "where you are") + (phone ? " (phone mode)" : "");
        setWatching(busy ? "Storm mode: " + count + " alert" + (count == 1 ? "" : "s") + " in range of " + place + ", checking every minute"
                         : "Watching " + place + ", checks your server every minute");
    }

    // notifications for warnings that have ended (or left the feed) are removed
    private void clearEnded(Set<Integer> current) {
        if (Build.VERSION.SDK_INT < 23) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        try {
            for (android.service.notification.StatusBarNotification sbn : nm.getActiveNotifications()) {
                if (sbn.getId() != ID_WATCH && "wx".equals(sbn.getTag()) && !current.contains(sbn.getId())) nm.cancel("wx", sbn.getId());
            }
        } catch (Exception ignored) { }
    }

    private long lifetime(JSONObject a) {
        // a notification disappears by itself when the warning expires (3 hours if it has no end time)
        try {
            String exp = a.optString("expires", "");
            if (Build.VERSION.SDK_INT >= 26 && !exp.isEmpty() && !"null".equals(exp)) {
                long t = java.time.OffsetDateTime.parse(exp).toInstant().toEpochMilli() - System.currentTimeMillis();
                if (t > 60_000) return t;
            }
        } catch (Exception ignored) { }
        return 3 * 3600_000L;
    }

    // warnings further away: an ordinary notification with the phone's normal sound, not read out
    private void notifyFar(JSONObject a) {
        String body = a.optString("speech") + (a.has("distance_km") && !a.isNull("distance_km") ? " (" + a.optInt("distance_km") + " km away)" : "");
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_FAR)
            .setSmallIcon(R.drawable.ic_stat_radarhound)
            .setContentTitle(a.optString("title"))
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setGroup(GROUP_FAR)
            .setTimeoutAfter(lifetime(a))
            .setAutoCancel(true).setContentIntent(openApp());
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify("wx", a.optString("id").hashCode(), b.build());
    }

    private void notify(JSONObject a) {
        boolean tor = "TOR".equals(a.optString("type"));
        boolean isBom = "BoM".equals(a.optString("source"));
        String title = a.optString("title");
        String body = isBom ? title : a.optString("speech");
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, tor ? CH_TOR : CH_WARN)
            .setSmallIcon(R.drawable.ic_stat_radarhound)
            .setContentTitle(title + (isBom ? " (BoM)" : ""))
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body + "\n\n" + a.optString("text")))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setColor(tor ? 0xFFFF2020 : isBom ? 0xFF62B6EA : 0xFFFFA500)
            .setTimeoutAfter(lifetime(a))
            .setAutoCancel(true)
            .setContentIntent(openApp());
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify("wx", a.optString("id").hashCode(), b.build());
    }

    private void announce(List<JSONObject> list) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean anyTor = false;
        for (JSONObject a : list) anyTor |= "TOR".equals(a.optString("type"));
        final boolean alarm = anyTor || p.getBoolean("loudSevere", false);   // alarm stream: heard on silent
        int toneMs = alarm ? playAlarmTone() : 0;      // otherwise the channel's own sound plays the tone
        if (!p.getBoolean("voice", true)) return;
        wake.acquire(5 * 60_000L);                   // stay awake until the announcement has been read out
        for (int i = 0; i < list.size(); i++)
            speechQueue.add(new String[]{(i == 0 ? "Radarhound alert. " : "") + list.get(i).optString("speech"), alarm ? "1" : "0"});
        if (!speaking) {
            speaking = true;
            handler.postDelayed(this::playNextSpeech, toneMs + (alarm ? 500 : 4000));
        }
    }

    // the server makes the voice (the same clear voice everywhere); the phone's own text-to-speech is the fallback
    private void playNextSpeech() {
        String[] next = speechQueue.poll();
        if (next == null) {
            speaking = false;
            if (wake.isHeld()) wake.release();
            return;
        }
        final String text = next[0];
        final boolean alarm = "1".equals(next[1]);
        String server = getSharedPreferences(PREFS, MODE_PRIVATE).getString("server", "");
        File wav = null;
        try { wav = download(server + "/api/speech?text=" + URLEncoder.encode(text, "UTF-8")); } catch (Exception ignored) { }
        if (wav != null) {
            try {
                releasePlayer(voicePlayer);
                MediaPlayer mp = new MediaPlayer();
                voicePlayer = mp;
                mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(alarm ? AudioAttributes.USAGE_ALARM : AudioAttributes.USAGE_NOTIFICATION_EVENT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                mp.setDataSource(wav.getAbsolutePath());
                mp.setOnCompletionListener(m -> { releasePlayer(m); voicePlayer = null; handler.postDelayed(this::playNextSpeech, 600); });
                mp.setOnErrorListener((m, w, x) -> { releasePlayer(m); voicePlayer = null; speakLocally(text, alarm); return true; });
                mp.prepare();
                mp.start();
                return;
            } catch (Exception ignored) { }
        }
        speakLocally(text, alarm);
    }

    private File download(String url) throws Exception {
        HttpURLConnection c = open(url);
        c.setConnectTimeout(5000); c.setReadTimeout(15000);
        try {
            if (c.getResponseCode() != 200) return null;
            File f = new File(getCacheDir(), "alert.wav");
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[16384]; int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return f.length() > 44 ? f : null;
        } finally { c.disconnect(); }
    }

    private void speakLocally(String text, boolean alarm) {
        if (!ttsReady) {
            // the speech engine may not have been ready when the service started: try again for next time
            try { tts.shutdown(); } catch (Exception ignored) { }
            tts = new TextToSpeech(this, this);
            handler.post(this::playNextSpeech);
            return;
        }
        Bundle params = new Bundle();
        params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, alarm ? AudioManager.STREAM_ALARM : AudioManager.STREAM_NOTIFICATION);
        if (tts.speak(text, TextToSpeech.QUEUE_ADD, params, "wx" + SystemClock.elapsedRealtime()) != TextToSpeech.SUCCESS)
            handler.post(this::playNextSpeech);
    }

    private int playAlarmTone() {
        try {
            releasePlayer(tonePlayer);
            MediaPlayer mp = new MediaPlayer();
            tonePlayer = mp;
            mp.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            mp.setDataSource(this, toneUri());
            mp.setOnCompletionListener(m -> { releasePlayer(m); tonePlayer = null; });
            mp.prepare();
            mp.start();
            return mp.getDuration();
        } catch (Exception e) { return 0; }
    }

    private static void releasePlayer(MediaPlayer mp) {
        if (mp == null) return;
        try { mp.release(); } catch (Exception ignored) { }
    }

    private Uri toneUri() {
        // by name, not by resource number: numbers change between builds, and a channel keeps its sound for good
        return Uri.parse("android.resource://" + getPackageName() + "/raw/alert_tone");
    }

    private Notification watchingNotification(String text) {
        return new NotificationCompat.Builder(this, CH_WATCH)
            .setSmallIcon(R.drawable.ic_stat_radarhound)
            .setContentTitle("Radarhound is watching for warnings")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true).setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(openApp()).build();
    }

    private void setWatching(String text) {
        if (text.equals(watchingText)) return;
        watchingText = text;
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(ID_WATCH, watchingNotification(text));
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void channels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.deleteNotificationChannel("warnings2");      // replaced: its sound pointed at a resource number
        NotificationChannel watch = new NotificationChannel(CH_WATCH, "Watching for warnings", NotificationManager.IMPORTANCE_MIN);
        watch.setShowBadge(false);
        AudioAttributes aa = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        NotificationChannel warn = new NotificationChannel(CH_WARN, "Severe weather warnings", NotificationManager.IMPORTANCE_HIGH);
        warn.setSound(toneUri(), aa);
        warn.enableVibration(true);
        warn.setVibrationPattern(new long[]{0, 600, 300, 600, 300, 600});
        NotificationChannel tor = new NotificationChannel(CH_TOR, "Tornado warnings", NotificationManager.IMPORTANCE_HIGH);
        tor.setSound(null, null);                 // the service plays the tone itself on the alarm stream
        tor.enableVibration(true);
        tor.setVibrationPattern(new long[]{0, 1000, 400, 1000, 400, 1000, 400, 1000});
        NotificationChannel further = new NotificationChannel(CH_FAR, "Warnings further away", NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(further);
        nm.createNotificationChannel(new NotificationChannel(CH_BRIEF, "Morning weather summary", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(watch);
        nm.createNotificationChannel(warn);
        nm.createNotificationChannel(tor);
    }
}
