package au.wxdeck.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restart background alerts after the phone reboots or the app updates. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        var p = ctx.getSharedPreferences(AlertService.PREFS, Context.MODE_PRIVATE);
        if (p.getBoolean("enabled", true) && (p.getString("server", null) != null || "phone".equals(p.getString("mode", "server")))) AlertService.start(ctx);
    }
}
