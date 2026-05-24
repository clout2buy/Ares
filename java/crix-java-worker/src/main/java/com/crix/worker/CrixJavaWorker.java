package com.crix.worker;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.TimeZone;

public final class CrixJavaWorker {
    private CrixJavaWorker() {}

    public static void main(String[] args) {
        String command = args.length > 0 ? args[0] : "probe";
        if ("probe".equals(command)) {
            printProbe();
            return;
        }
        if ("score".equals(command)) {
            String query = args.length > 1 ? args[1] : "";
            String text = args.length > 2 ? args[2] : "";
            double score = score(query, text);
            System.out.println("{\"score\":" + score + "}");
            return;
        }
        System.err.println("unknown command: " + command);
        System.exit(2);
    }

    private static void printProbe() {
        String javaVersion = System.getProperty("java.version", "unknown");
        String cwd = new File(".").getAbsolutePath();
        System.out.println("{"
            + "\"name\":\"crix-java-worker\"," 
            + "\"javaVersion\":\"" + escape(javaVersion) + "\"," 
            + "\"cwd\":\"" + escape(cwd) + "\"," 
            + "\"time\":\"" + escape(now()) + "\"," 
            + "\"capabilities\":[\"probe\",\"score\",\"future-static-analysis\"]"
            + "}");
    }

    private static double score(String query, String text) {
        String[] q = query.toLowerCase().split("[^a-z0-9_]+", -1);
        String lower = text.toLowerCase();
        int total = 0;
        int hits = 0;
        for (int i = 0; i < q.length; i++) {
            if (q[i].length() < 2) continue;
            total++;
            if (lower.contains(q[i])) hits++;
        }
        if (total == 0) return 0.0;
        return ((double) hits) / ((double) total);
    }

    private static String now() {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date());
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
