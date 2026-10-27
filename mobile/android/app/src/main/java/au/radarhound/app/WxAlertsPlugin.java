package au.radarhound.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Bridge for the app's start screen: remember the server and start or stop background alerts. */
@CapacitorPlugin(
    name = "WxAlerts",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "bgLocation", strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION })
    }
)
public class WxAlertsPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences.Editor e = ctx.getSharedPreferences(AlertService.PREFS, Context.MODE_PRIVATE).edit();
        e.putString("server", call.getString("server"));
        e.putString("mode", call.getString("mode", "server"));
        e.putBoolean("enabled", call.getBoolean("enabled", true));
        e.putString("scope", call.getString("scope", "near"));
        e.putBoolean("voice", call.getBoolean("voice", true));
        e.putBoolean("bom", call.getBoolean("bom", true));
        e.putInt("near", call.getInt("near", 50));
        e.putBoolean("far", call.getBoolean("far", true));
        e.putBoolean("loudSevere", call.getBoolean("loudSevere", false));
        e.putBoolean("ltg", call.getBoolean("ltg", true));
        e.putBoolean("arr", call.getBoolean("arr", true));
        e.putBoolean("rain", call.getBoolean("rain", false));
        e.putString("where", call.getString("where", "home"));
        e.putString("key", call.getString("key", ""));
        e.putInt("quietFrom", call.getInt("quietFrom", -1));
        e.putInt("quietTo", call.getInt("quietTo", 7));
        e.putInt("briefHour", call.getInt("briefHour", -1));
        e.apply();
        if (!call.getBoolean("enabled", true)) {
            ctx.stopService(new Intent(ctx, AlertService.class));
            finish(call);
            return;
        }
        // Android 13+: ask for permission to show notifications first, then carry on in the callback
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsResult");
            return;
        }
        askLocation(call);
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        askLocation(call);
    }

    // alerts for where the phone is: location while in use first, then "allow all the time" (Android asks
    // for the second one on its own settings screen)
    private void askLocation(PluginCall call) {
        if (!"me".equals(call.getString("where", "home"))) { begin(call); return; }
        if (getPermissionState("location") != PermissionState.GRANTED) { requestPermissionForAlias("location", call, "locationResult"); return; }
        if (Build.VERSION.SDK_INT >= 29 && getPermissionState("bgLocation") != PermissionState.GRANTED) { requestPermissionForAlias("bgLocation", call, "bgLocationResult"); return; }
        begin(call);
    }

    @PermissionCallback
    private void locationResult(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED && Build.VERSION.SDK_INT >= 29
                && getPermissionState("bgLocation") != PermissionState.GRANTED) {
            requestPermissionForAlias("bgLocation", call, "bgLocationResult");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void bgLocationResult(PluginCall call) {
        begin(call);
    }

    private void begin(PluginCall call) {
        Context ctx = getContext();
        // a one-off prompt so Android's battery saver doesn't put the minute-by-minute check to sleep
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (call.getBoolean("askBattery", true) && !pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
            try {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName()));
                getActivity().startActivity(i);
            } catch (Exception ignored) { }
        }
        try { AlertService.start(ctx); } catch (Exception ignored) { }
        AlertService s = AlertService.instance;
        if (s != null) { s.stopLocation(); s.startLocation(); }       // settings changed: pick up the new choice
        finish(call);
    }

    private void finish(PluginCall call) {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        JSObject r = new JSObject();
        r.put("ok", true);
        r.put("notifications", NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        r.put("battery", pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        boolean loc = getPermissionState("location") == PermissionState.GRANTED
            && (Build.VERSION.SDK_INT < 29 || getPermissionState("bgLocation") == PermissionState.GRANTED);
        r.put("location", loc);
        call.resolve(r);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Context ctx = getContext();
        Intent i = Build.VERSION.SDK_INT >= 26
            ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName())
            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName()));
        try { getActivity().startActivity(i); } catch (Exception ignored) { }
        call.resolve();
    }

    /** Phone mode: home as set in the app's page (the background alerts use it). */
    @PluginMethod
    public void setPhoneHome(PluginCall call) {
        Double lat = call.getDouble("lat"), lon = call.getDouble("lon");
        if (lat == null || lon == null) { call.reject("need lat and lon"); return; }
        getContext().getSharedPreferences(AlertService.PREFS, Context.MODE_PRIVATE).edit()
            .putFloat("homeLat", lat.floatValue()).putFloat("homeLon", lon.floatValue()).putString("homeName", call.getString("name", "Home")).apply();
        call.resolve();
    }

    /** The page is on screen (phone mode alerts come from the page then, not the background service). */
    @PluginMethod
    public void pageVisible(PluginCall call) {
        AlertService.pageVisible = call.getBoolean("visible", false);
        call.resolve();
    }

    // ---------------------------------------------------------------- the phone's own voice (phone mode)
    private android.speech.tts.TextToSpeech tts;
    private boolean ttsReady = false;
    private final java.util.Map<String, PluginCall> speaking = new java.util.HashMap<>();

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text.isEmpty()) { call.resolve(); return; }
        call.setKeepAlive(true);
        Runnable go = () -> {
            String id = "wx" + System.nanoTime();
            synchronized (speaking) { speaking.put(id, call); }
            android.os.Bundle params = new android.os.Bundle();
            params.putInt(android.speech.tts.TextToSpeech.Engine.KEY_PARAM_STREAM, android.media.AudioManager.STREAM_NOTIFICATION);
            if (tts.speak(text, android.speech.tts.TextToSpeech.QUEUE_ADD, params, id) != android.speech.tts.TextToSpeech.SUCCESS) done(id);
        };
        if (tts != null && ttsReady) { go.run(); return; }
        tts = new android.speech.tts.TextToSpeech(getContext(), status -> {
            if (status != android.speech.tts.TextToSpeech.SUCCESS) { call.setKeepAlive(false); call.reject("no text-to-speech"); return; }
            int r = tts.setLanguage(new java.util.Locale("en", "AU"));
            if (r == android.speech.tts.TextToSpeech.LANG_MISSING_DATA || r == android.speech.tts.TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(java.util.Locale.ENGLISH);
            tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { done(id); }
                @Override public void onError(String id) { done(id); }
            });
            ttsReady = true;
            go.run();
        });
    }

    private void done(String id) {
        PluginCall c;
        synchronized (speaking) { c = speaking.remove(id); }
        if (c != null) { c.setKeepAlive(false); c.resolve(); }
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences p = getContext().getSharedPreferences(AlertService.PREFS, Context.MODE_PRIVATE);
        JSObject r = new JSObject();
        r.put("enabled", p.getBoolean("enabled", true));
        r.put("scope", p.getString("scope", "near"));
        r.put("voice", p.getBoolean("voice", true));
        r.put("bom", p.getBoolean("bom", true));
        r.put("notifications", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        call.resolve(r);
    }
}
