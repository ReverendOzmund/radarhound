package au.radarhound.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Background alerts in phone mode (no Radarhound server): BoM's severe warnings that name a place near you,
 * and lightning within 15 km from the LightningMaps feed. Builds the same alert objects as the server's
 * /api/alerts, so AlertService handles them the same way. Radarhound's own radar warnings, storm arrival
 * and rain-soon alerts need the radar processing that only runs while the app is open.
 */
final class PhoneAlerts {
    private static final String BOM = "https://reg.bom.gov.au";
    private static final String UA = "Mozilla/5.0 (Linux; Android 14) radarhound-phone";
    private static final Map<String, String> FEED = new HashMap<>();
    static {
        FEED.put("W", "IDZ00060.warnings_wa"); FEED.put("N", "IDZ00054.warnings_nsw"); FEED.put("V", "IDZ00059.warnings_vic");
        FEED.put("Q", "IDZ00056.warnings_qld"); FEED.put("S", "IDZ00057.warnings_sa"); FEED.put("T", "IDZ00058.warnings_tas"); FEED.put("D", "IDZ00055.warnings_nt");
    }
    private static JSONArray towns = null;
    private static final Map<String, Object[]> pageCache = new HashMap<>();     // link -> {time, text}

    static String stateOf(double la, double lo) {
        if (lo < 129) return "W";
        if (la < -39.3) return "T";
        if (lo < 138 && la > -26) return "D";
        if (lo < 141) return "S";
        if (la > -28.6) return "Q";
        if (la < -34 && lo < 150 && (la < -36 || lo < 144.5)) return "V";
        return "N";
    }

    static double km(double a, double b, double c, double d) {
        return Math.hypot((a - c) * 111.11, (b - d) * 111.11 * Math.cos(Math.toRadians(a)));
    }

    private static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("User-Agent", UA);
        c.setConnectTimeout(15000); c.setReadTimeout(20000);
        try {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                String line; while ((line = r.readLine()) != null) sb.append(line).append('\n');
            }
            return sb.toString();
        } finally { c.disconnect(); }
    }

    private static List<String> townsNear(Context ctx, double lat, double lon, double nearKm) {
        List<String> out = new ArrayList<>();
        try {
            if (towns == null) {
                try (InputStream in = ctx.getAssets().open("public/data/towns.json")) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] b = new byte[16384]; int n;
                    while ((n = in.read(b)) > 0) bo.write(b, 0, n);
                    towns = new JSONObject(bo.toString("UTF-8")).getJSONArray("towns");
                }
            }
            for (int i = 0; i < towns.length() && out.size() < 60; i++) {
                JSONObject t = towns.getJSONObject(i);
                String n = t.optString("n");
                if (n.length() > 3 && km(lat, lon, t.getDouble("la"), t.getDouble("lo")) <= nearKm) out.add(n);
            }
        } catch (Exception ignored) { }
        return out;
    }

    static JSONArray alerts(Context ctx, SharedPreferences p, double lat, double lon) throws Exception {
        JSONArray out = new JSONArray();
        int near = p.getInt("near", 50);
        // ---- BoM severe warnings naming a nearby place
        String xml = get(BOM + "/fwo/" + FEED.get(stateOf(lat, lon)) + ".xml");
        List<String> local = townsNear(ctx, lat, lon, near);
        Matcher m = Pattern.compile("<item>.*?<title>(.*?)</title>.*?<link>(.*?)</link>", Pattern.DOTALL).matcher(xml);
        while (m.find()) {
            String title = m.group(1).replaceAll("\\s+", " ").replaceAll("^\\d{2}/\\d{2}:\\d{2}\\s+\\w+\\s+", "").trim();
            String link = m.group(2).trim().replace("http://", "https://");
            String low = title.toLowerCase(Locale.ROOT);
            if (low.startsWith("cancellation") || low.startsWith("final") || low.contains("marine wind") || low.contains("sheep graziers")) continue;
            boolean severe = low.matches(".*(thunderstorm|severe weather|cyclone|tsunami|emergency|fire weather|heatwave|bushfire).*")
                || (low.contains("flood") && (low.contains("major") || low.contains("moderate")));
            if (!severe) continue;
            String text;
            Object[] hit = pageCache.get(link);
            if (hit != null && System.currentTimeMillis() - (long) hit[0] < 600_000L) text = (String) hit[1];
            else {
                try { text = get(link).replaceAll("<[^>]+>", " ").replaceAll("\\s+", " ").toLowerCase(Locale.ROOT); } catch (Exception e) { text = ""; }
                pageCache.put(link, new Object[]{System.currentTimeMillis(), text});
            }
            List<String> hits = new ArrayList<>();
            for (String n : local) if (Pattern.compile("\\b" + Pattern.quote(n.toLowerCase(Locale.ROOT)) + "\\b").matcher(low + " " + text).find()) hits.add(n);
            if (hits.isEmpty()) continue;
            JSONObject a = new JSONObject();
            a.put("id", "bom-" + Integer.toHexString((link + "|" + title).hashCode()));
            a.put("source", "BoM"); a.put("type", "BOM"); a.put("severity", 2); a.put("near", true);
            a.put("title", title); a.put("text", title);
            String places = hits.size() == 1 ? hits.get(0) : String.join(", ", hits.subList(0, Math.min(3, hits.size()) - 1)) + " and " + hits.get(Math.min(3, hits.size()) - 1);
            a.put("speech", "Bureau of Meteorology. " + title.replaceAll("([A-Z]{4,})", "$1").toLowerCase(Locale.ROOT) + ". This includes " + places + ".");
            out.put(a);
        }
        // ---- lightning close by
        Lightning.watch(lat, lon);
        long now = System.currentTimeMillis();
        int n = 0; double closest = 1e9; long first = Long.MAX_VALUE;
        synchronized (Lightning.strikes) {
            for (double[] s : Lightning.strikes) {
                if (s[0] < now - 600_000L) continue;
                double d = km(lat, lon, s[1], s[2]);
                if (d <= 15) { n++; closest = Math.min(closest, d); first = Math.min(first, (long) s[0]); }
            }
        }
        if (n > 0) {
            JSONObject a = new JSONObject();
            a.put("id", "ltg-" + (first / 1_800_000L)); a.put("source", "radarhound"); a.put("type", "LTG"); a.put("severity", 1); a.put("near", true);
            a.put("title", "Lightning nearby"); a.put("distance_km", Math.round(closest));
            a.put("text", n + " lightning strike" + (n > 1 ? "s" : "") + " within 15 km in the last 10 minutes, the closest " + Math.round(closest) + " km away.");
            a.put("speech", "Lightning within " + Math.max(1, Math.round(closest)) + " kilometres. Head indoors.");
            out.put(a);
        }
        return out;
    }

    /** Just enough WebSocket client for LightningMaps' feed (one small box around the point). */
    static final class Lightning {
        static final ArrayDeque<double[]> strikes = new ArrayDeque<>();
        private static Thread thread = null;
        private static volatile double wLat = 999, wLon = 999;
        private static volatile long lastWanted = 0;

        static synchronized void watch(double lat, double lon) {
            lastWanted = System.currentTimeMillis();
            boolean moved = km(lat, lon, wLat, wLon) > 20;
            wLat = lat; wLon = lon;
            if (thread != null && thread.isAlive() && !moved) return;
            if (thread != null) thread.interrupt();
            thread = new Thread(Lightning::run, "radarhound-lightning");
            thread.setDaemon(true);
            thread.start();
        }

        private static void run() {
            Thread me = Thread.currentThread();
            while (!me.isInterrupted() && System.currentTimeMillis() - lastWanted < 10 * 60_000L) {
                try { session(me); } catch (Exception ignored) { }
                try { Thread.sleep(20_000); } catch (InterruptedException e) { return; }
            }
        }

        private static void session(Thread me) throws Exception {
            String host = (System.currentTimeMillis() / 60_000L) % 2 == 0 ? "live.lightningmaps.org" : "live2.lightningmaps.org";
            try (SSLSocket s = (SSLSocket) SSLSocketFactory.getDefault().createSocket(host, 443)) {
                s.setSoTimeout(240_000);
                s.startHandshake();
                byte[] keyRaw = new byte[16]; new SecureRandom().nextBytes(keyRaw);
                String key = android.util.Base64.encodeToString(keyRaw, android.util.Base64.NO_WRAP);
                OutputStream out = s.getOutputStream();
                out.write(("GET / HTTP/1.1\r\nHost: " + host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key
                    + "\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost\r\nUser-Agent: " + UA + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.flush();
                InputStream in = s.getInputStream();
                StringBuilder hdr = new StringBuilder();
                while (!hdr.toString().endsWith("\r\n\r\n")) { int b = in.read(); if (b < 0) return; hdr.append((char) b); }
                if (!hdr.toString().startsWith("HTTP/1.1 101")) return;
                double dl = 0.5, dn = 0.5 / Math.cos(Math.toRadians(wLat));
                String sub = String.format(Locale.US, "{\"v\":24,\"i\":{},\"s\":false,\"x\":0,\"w\":0,\"tx\":0,\"tw\":1,\"a\":4,\"z\":4,\"b\":true,\"h\":\"\",\"l\":1,\"t\":1,\"from_lightningmaps_org\":true,\"p\":[%.2f,%.2f,%.2f,%.2f]}",
                    wLat + dl, wLon + dn, wLat - dl, wLon - dn);
                send(out, 1, sub.getBytes(StandardCharsets.UTF_8));
                ByteArrayOutputStream msg = new ByteArrayOutputStream();
                while (!me.isInterrupted() && System.currentTimeMillis() - lastWanted < 10 * 60_000L) {
                    int b0 = in.read(), b1 = in.read();
                    if (b0 < 0 || b1 < 0) return;
                    int op = b0 & 0x0f; long len = b1 & 0x7f;
                    if (len == 126) len = (in.read() << 8) | in.read();
                    else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | in.read(); }
                    byte[] data = new byte[(int) len]; int got = 0;
                    while (got < len) { int r = in.read(data, got, (int) len - got); if (r < 0) return; got += r; }
                    if (op == 8) return;
                    if (op == 9) { send(out, 10, data); continue; }
                    if (op == 1 || op == 0) {
                        msg.write(data);
                        if ((b0 & 0x80) != 0) { handle(msg.toString("UTF-8")); msg.reset(); }
                    }
                }
            }
        }

        private static void send(OutputStream out, int op, byte[] payload) throws Exception {
            ByteArrayOutputStream f = new ByteArrayOutputStream();
            f.write(0x80 | op);
            if (payload.length < 126) f.write(0x80 | payload.length);
            else { f.write(0x80 | 126); f.write(payload.length >> 8); f.write(payload.length & 0xff); }
            byte[] mask = new byte[4]; new SecureRandom().nextBytes(mask); f.write(mask);
            for (int i = 0; i < payload.length; i++) f.write(payload[i] ^ mask[i % 4]);
            out.write(f.toByteArray()); out.flush();
        }

        private static void handle(String text) {
            try {
                JSONArray st = new JSONObject(text).optJSONArray("strokes");
                if (st == null) return;
                long cut = System.currentTimeMillis() - 30 * 60_000L;
                synchronized (strikes) {
                    for (int i = 0; i < st.length(); i++) {
                        JSONObject o = st.getJSONObject(i);
                        if (!o.has("lat") || !o.has("time")) continue;
                        strikes.add(new double[]{o.getDouble("time"), o.getDouble("lat"), o.getDouble("lon")});
                    }
                    for (Iterator<double[]> it = strikes.iterator(); it.hasNext(); ) if (it.next()[0] < cut) it.remove();
                    while (strikes.size() > 5000) strikes.poll();
                }
            } catch (Exception ignored) { }
        }
    }
}
