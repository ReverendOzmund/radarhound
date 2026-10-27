package au.radarhound.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;

/** Backup alarm for the alert service: Android may hold back its minute timer while the phone dozes. */
public class PollReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        var p = ctx.getSharedPreferences(AlertService.PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("enabled", true) || (p.getString("server", null) == null && !"phone".equals(p.getString("mode", "server")))) return;
        AlertService s = AlertService.instance;
        if (s != null) { s.poke(); return; }
        // the service was stopped (low memory): start it again; it checks straight away
        PowerManager.WakeLock w = ((PowerManager) ctx.getSystemService(Context.POWER_SERVICE))
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "radarhound:restart");
        w.acquire(20_000);
        try { AlertService.start(ctx); } catch (Exception ignored) { }
    }
}
