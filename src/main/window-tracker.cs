using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class ActiveWindowTracker {
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    static void Main() {
        // Set console output to UTF-8 to handle Arabic and other Unicode characters
        Console.OutputEncoding = Encoding.UTF8;

        IntPtr lastHwnd = IntPtr.Zero;
        while (true) {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd != lastHwnd) {
                lastHwnd = hwnd;
                StringBuilder sb = new StringBuilder(512);
                if (GetWindowText(hwnd, sb, 512) > 0) {
                    Console.WriteLine(sb.ToString().Trim());
                } else {
                    Console.WriteLine("Unknown Window");
                }
            }
            Thread.Sleep(1000); // Check every 1 second
        }
    }
}
