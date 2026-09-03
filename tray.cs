// GameUploader tray helper — a tray icon plus window control for the terminal window.
// Compiled on first run by the C# compiler that ships with Windows (.NET Framework), see tray.js.
//
// Protocol (one command per line):
//   stdin  (from Node):  tooltip <text> | icon idle|busy|error|paused | menu-pause 0|1 | menu-autostart 0|1
//                        show | shownoactivate | hide | toggle | minimize | flash | query | quit
//   stdout (to Node):    click | show | copy | open | folder | pause | resume | autostart 0|1 | quit
//                        visible 0|1 (reply to query) | ready
// The helper exits by itself when stdin closes (Node died).

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class Tray : ApplicationContext
{
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool FlashWindow(IntPtr h, bool invert);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    delegate bool EnumProc(IntPtr h, IntPtr lp);

    const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9;
    const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
    static readonly IntPtr HWND_TOP = IntPtr.Zero;

    readonly string windowTitle;
    readonly NotifyIcon icon;
    readonly MenuItem pauseItem, autostartItem;
    readonly Icon[] icons = new Icon[4];   // idle, busy, error, paused
    IntPtr hwnd = IntPtr.Zero;
    readonly object writeLock = new object();
    readonly Control sync;   // hidden control whose handle lets the reader thread marshal onto the UI thread

    Tray(string title, string tooltip)
    {
        windowTitle = title;
        sync = new Control();
        var forceHandle = sync.Handle;
        icons[0] = MakeIcon(Color.FromArgb(45, 150, 170));   // idle   — teal/cyan
        icons[1] = MakeIcon(Color.FromArgb(212, 83, 126));   // busy   — pink
        icons[2] = MakeIcon(Color.FromArgb(226, 75, 74));    // error  — red
        icons[3] = MakeIcon(Color.FromArgb(136, 135, 128));  // paused — gray

        var menu = new ContextMenu();
        menu.MenuItems.Add(new MenuItem("Show window", (s, e) => Send("show")) { DefaultItem = true });
        menu.MenuItems.Add(new MenuItem("Copy last link", (s, e) => Send("copy")));
        menu.MenuItems.Add(new MenuItem("Open last clip", (s, e) => Send("open")));
        menu.MenuItems.Add(new MenuItem("Open watch folder", (s, e) => Send("folder")));
        menu.MenuItems.Add("-");
        pauseItem = new MenuItem("Pause watching", (s, e) => Send(pauseItem.Checked ? "resume" : "pause"));
        menu.MenuItems.Add(pauseItem);
        autostartItem = new MenuItem("Start with Windows", (s, e) => Send("autostart " + (autostartItem.Checked ? "0" : "1")));
        menu.MenuItems.Add(autostartItem);
        menu.MenuItems.Add("-");
        menu.MenuItems.Add(new MenuItem("Quit", (s, e) => Send("quit")));

        icon = new NotifyIcon { Icon = icons[0], Text = Clip(tooltip), ContextMenu = menu, Visible = true };
        icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Send("click"); };
        icon.DoubleClick += (s, e) => Send("show");

        var reader = new Thread(ReadLoop) { IsBackground = true };
        reader.Start();
        Send("ready");
    }

    // A 16x16 pixel-art "▲" on a rounded dark tile, in the given color.
    static Icon MakeIcon(Color c)
    {
        var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.None;
            g.Clear(Color.Transparent);
            using (var bg = new SolidBrush(Color.FromArgb(28, 28, 30))) g.FillRectangle(bg, 2, 2, 28, 28);
            using (var fg = new SolidBrush(c))
            {
                // stepped triangle, 4px blocks
                g.FillRectangle(fg, 14, 6, 4, 4);
                g.FillRectangle(fg, 10, 10, 12, 4);
                g.FillRectangle(fg, 6, 14, 20, 4);
                g.FillRectangle(fg, 6, 18, 20, 2);
                g.FillRectangle(fg, 10, 22, 4, 4);
                g.FillRectangle(fg, 18, 22, 4, 4);
            }
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    static string Clip(string s) { return s.Length > 63 ? s.Substring(0, 60) + "..." : s; }

    void Send(string line) { lock (writeLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

    [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);

    // The terminal window whose title contains our name. Windows Terminal's real window has class
    // CASCADIA_HOSTING_WINDOW_CLASS; prefer it (then any visible match) over transient helper windows.
    IntPtr FindWindow()
    {
        if (hwnd != IntPtr.Zero && IsWindow(hwnd)) return hwnd;
        IntPtr best = IntPtr.Zero; int bestScore = -1;
        EnumWindows((h, lp) =>
        {
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, 256);
            if (!sb.ToString().Contains(windowTitle)) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            var c = cls.ToString();
            int score = c == "CASCADIA_HOSTING_WINDOW_CLASS" ? 3 : c == "ConsoleWindowClass" ? 2 : IsWindowVisible(h) ? 1 : 0;
            if (score > bestScore) { bestScore = score; best = h; }
            return true;
        }, IntPtr.Zero);
        hwnd = best;
        return best;
    }

    void Show(bool activate)
    {
        var h = FindWindow(); if (h == IntPtr.Zero) return;
        if (activate)
        {
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE); else ShowWindow(h, SW_SHOW);
            // Windows only lets the foreground thread hand focus over; attach to it briefly so the window really comes to front.
            uint fgPid;
            uint fgThread = GetWindowThreadProcessId(GetForegroundWindowSafe(), out fgPid), me = GetCurrentThreadId();
            if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, true);
            SetForegroundWindow(h);
            if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, false);
        }
        else
        {
            if (IsIconic(h)) ShowWindow(h, SW_SHOWNOACTIVATE);
            SetWindowPos(h, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static IntPtr GetForegroundWindowSafe() { try { return GetForegroundWindow(); } catch { return IntPtr.Zero; } }

    void Handle(string line)
    {
        var sp = line.IndexOf(' ');
        var cmd = sp < 0 ? line : line.Substring(0, sp);
        var arg = sp < 0 ? "" : line.Substring(sp + 1);
        switch (cmd)
        {
            case "tooltip": icon.Text = Clip(arg); break;
            case "icon":
                icon.Icon = arg == "busy" ? icons[1] : arg == "error" ? icons[2] : arg == "paused" ? icons[3] : icons[0];
                break;
            case "menu-pause": pauseItem.Checked = arg == "1"; pauseItem.Text = arg == "1" ? "Resume watching" : "Pause watching"; break;
            case "menu-autostart": autostartItem.Checked = arg == "1"; break;
            case "show": Show(true); break;
            case "shownoactivate": Show(false); break;
            case "hide": { var h = FindWindow(); if (h != IntPtr.Zero) ShowWindow(h, SW_HIDE); break; }
            case "minimize": { var h = FindWindow(); if (h != IntPtr.Zero) ShowWindow(h, SW_MINIMIZE); break; }
            case "toggle": { var h = FindWindow(); if (h != IntPtr.Zero) { if (IsWindowVisible(h) && !IsIconic(h)) ShowWindow(h, SW_HIDE); else Show(true); } break; }
            case "flash": { var h = FindWindow(); if (h != IntPtr.Zero) FlashWindow(h, true); break; }
            case "query": { var h = FindWindow(); Send("visible " + (h != IntPtr.Zero && IsWindowVisible(h) && !IsIconic(h) ? "1" : "0")); break; }
            case "quit": Exit(); break;
        }
    }

    void ReadLoop()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                var l = line.Trim();
                if (l.Length == 0) continue;
                sync.BeginInvoke((Action)(() => Handle(l)));   // run on the UI thread
            }
        }
        catch { }
        try { sync.BeginInvoke((Action)Exit); } catch { Environment.Exit(0); }   // stdin closed: Node is gone
    }

    void Exit()
    {
        try { icon.Visible = false; icon.Dispose(); } catch { }
        try { Application.Exit(); } catch { }
        Environment.Exit(0);
    }

    [STAThread]
    static void Main(string[] args)
    {
        var title = args.Length > 0 ? args[0] : "GameUploader";
        var tooltip = args.Length > 1 ? args[1] : title;
        Application.EnableVisualStyles();
        Application.Run(new Tray(title, tooltip));
    }
}
