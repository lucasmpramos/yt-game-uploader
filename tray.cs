// GameUploader tray helper — a tray icon plus window control for the terminal window.
// Compiled on first run by the C# compiler that ships with Windows (.NET Framework), see tray.js.
//
// Protocol (one command per line):
//   stdin  (from Node):  tooltip <text> | status <text> | icon idle|error|paused | icon busy <pct>
//                        menu-pause 0|1 | menu-autostart 0|1 | recent-clear | recent-add <id>\t<title>
//                        show | shownoactivate | hide | toggle | minimize | flash | query | quit
//   stdout (to Node):    click | show | copy | open | folder | pause | resume | autostart 0|1 | recent <id> | quit
//                        visible 0|1 (reply to query) | ready
// The helper exits by itself when stdin closes (Node died).

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

class Tray : ApplicationContext
{
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool FlashWindow(IntPtr h, bool invert);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    delegate bool EnumProc(IntPtr h, IntPtr lp);

    const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9;
    const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;

    // Palette (matches the terminal logo)
    static readonly Color IDLE = Color.FromArgb(212, 83, 126), BUSY = Color.FromArgb(64, 192, 112),
                          ERR = Color.FromArgb(226, 75, 74), PAUSED = Color.FromArgb(136, 135, 128),
                          TILE_DARK = Color.FromArgb(38, 38, 42);

    readonly string windowTitle;
    readonly NotifyIcon icon;
    readonly ContextMenuStrip menu;
    readonly ToolStripMenuItem statusItem, pauseItem, autostartItem, recentItem;
    readonly Dictionary<string, Icon> iconCache = new Dictionary<string, Icon>();
    readonly Control sync;
    readonly object writeLock = new object();
    IntPtr hwnd = IntPtr.Zero;
    // No console in a winexe: talk to Node over the raw stdin/stdout pipes, UTF-8, no BOM.
    static readonly TextReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    static readonly TextWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

    Tray(string title, string tooltip)
    {
        windowTitle = title;
        sync = new Control();
        var forceHandle = sync.Handle;

        bool dark = IsDarkTheme();
        menu = new ContextMenuStrip { Renderer = new MenuRenderer(dark), ShowImageMargin = false, ShowCheckMargin = true };
        menu.Font = new Font("Segoe UI", 9.5f);
        statusItem = new ToolStripMenuItem(title) { Enabled = false };
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());
        var showItem = new ToolStripMenuItem("Show window", null, (s, e) => Send("show"));
        showItem.Font = new Font(menu.Font, FontStyle.Bold);
        menu.Items.Add(showItem);
        menu.Items.Add(new ToolStripMenuItem("Copy last link", null, (s, e) => Send("copy")));
        menu.Items.Add(new ToolStripMenuItem("Open last clip", null, (s, e) => Send("open")));
        recentItem = new ToolStripMenuItem("Recent uploads");
        recentItem.DropDown.Renderer = menu.Renderer;
        recentItem.DropDown.Font = menu.Font;
        menu.Items.Add(recentItem);
        menu.Items.Add(new ToolStripMenuItem("Open watch folder", null, (s, e) => Send("folder")));
        menu.Items.Add(new ToolStripSeparator());
        pauseItem = new ToolStripMenuItem("Pause watching", null, (s, e) => Send(pauseItem.Checked ? "resume" : "pause"));
        menu.Items.Add(pauseItem);
        autostartItem = new ToolStripMenuItem("Start with Windows", null, (s, e) => Send("autostart " + (autostartItem.Checked ? "0" : "1")));
        menu.Items.Add(autostartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit", null, (s, e) => Send("quit")));
        SetRecent(new List<KeyValuePair<string, string>>());

        icon = new NotifyIcon { Icon = GetIcon(IDLE, -1), Text = Clip(tooltip), ContextMenuStrip = menu, Visible = true };
        icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Send("click"); };
        icon.DoubleClick += (s, e) => Send("show");

        var reader = new Thread(ReadLoop) { IsBackground = true };
        reader.Start();
        Send("ready");
    }

    static bool IsDarkTheme()
    {
        try
        {
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                var v = k == null ? null : k.GetValue("SystemUsesLightTheme");
                return v == null || Convert.ToInt32(v) == 0;
            }
        }
        catch { return true; }
    }

    // ---- icon: colored rounded tile with a white pixel "▲"; busy tiles fill bottom-up with the upload progress ----
    Icon GetIcon(Color c, int pct)
    {
        int bucket = pct < 0 ? -1 : (pct / 10) * 10;   // one icon per 10% step
        string key = c.ToArgb() + ":" + bucket;
        Icon ic;
        if (iconCache.TryGetValue(key, out ic)) return ic;
        ic = BuildIcon(c, bucket);
        iconCache[key] = ic;
        return ic;
    }

    static Icon BuildIcon(Color c, int pct)
    {
        int[] sizes = { 16, 20, 24, 32 };
        var pngs = new List<byte[]>();
        foreach (var s in sizes) pngs.Add(RenderPng(s, c, pct));
        // Assemble a .ico (PNG entries) so Windows picks the right size for the current DPI.
        using (var ms = new MemoryStream())
        using (var w = new BinaryWriter(ms))
        {
            w.Write((short)0); w.Write((short)1); w.Write((short)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                w.Write((byte)(sizes[i] == 256 ? 0 : sizes[i])); w.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                w.Write((byte)0); w.Write((byte)0); w.Write((short)1); w.Write((short)32);
                w.Write(pngs[i].Length); w.Write(offset);
                offset += pngs[i].Length;
            }
            foreach (var p in pngs) w.Write(p);
            ms.Position = 0;
            return new Icon(ms);
        }
    }

    static byte[] RenderPng(int size, Color c, int pct)
    {
        using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                float r = size * 0.22f;
                var tile = RoundedRect(new RectangleF(0.5f, 0.5f, size - 1, size - 1), r);
                if (pct < 0)
                {
                    using (var b = new SolidBrush(c)) g.FillPath(b, tile);
                }
                else
                {
                    // dark tile, colored fill rising with progress
                    using (var b = new SolidBrush(TILE_DARK)) g.FillPath(b, tile);
                    float h = (size - 1) * Math.Max(0.08f, pct / 100f);
                    var old = g.Clip;
                    g.SetClip(tile);
                    using (var b = new SolidBrush(c)) g.FillRectangle(b, 0, size - h, size, h);
                    g.Clip = old;
                }
                // white ▲: a stepped pyramid so it stays crisp at 16 px
                g.SmoothingMode = SmoothingMode.None;
                using (var wb = new SolidBrush(Color.White))
                {
                    int unit = Math.Max(1, size / 8);           // 2 px at 16, 4 px at 32
                    int cx = size / 2, baseY = size - unit * 2 - (size >= 24 ? 1 : 0);
                    int rows = 3;
                    for (int i = 0; i < rows; i++)
                    {
                        int half = unit * (i + 1);
                        int y = baseY - (rows - 1 - i) * unit;
                        g.FillRectangle(wb, cx - half, y - unit, half * 2, unit);
                    }
                    g.FillRectangle(wb, cx - unit / 2 - (unit % 2 == 0 ? 0 : 0), baseY - rows * unit - unit, unit, unit);
                }
            }
            using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
        }
    }

    static GraphicsPath RoundedRect(RectangleF rc, float r)
    {
        var p = new GraphicsPath();
        float d = r * 2;
        p.AddArc(rc.X, rc.Y, d, d, 180, 90);
        p.AddArc(rc.Right - d, rc.Y, d, d, 270, 90);
        p.AddArc(rc.Right - d, rc.Bottom - d, d, d, 0, 90);
        p.AddArc(rc.X, rc.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    // ---- menu rendering: hover highlight + light/dark theme ----
    class MenuRenderer : ToolStripProfessionalRenderer
    {
        readonly bool dark;
        readonly Color bg, fg, dim, hover, sep;
        public MenuRenderer(bool dark) : base(new ProfessionalColorTable { UseSystemColors = false })
        {
            this.dark = dark;
            bg = dark ? Color.FromArgb(32, 32, 34) : Color.FromArgb(249, 249, 249);
            fg = dark ? Color.FromArgb(240, 240, 240) : Color.FromArgb(28, 28, 28);
            dim = dark ? Color.FromArgb(150, 150, 150) : Color.FromArgb(110, 110, 110);
            hover = dark ? Color.FromArgb(60, 60, 64) : Color.FromArgb(225, 225, 225);
            sep = dark ? Color.FromArgb(58, 58, 60) : Color.FromArgb(215, 215, 215);
            RoundedEdges = false;
        }
        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { using (var b = new SolidBrush(bg)) e.Graphics.FillRectangle(b, e.AffectedBounds); }
        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) { using (var p = new Pen(sep)) e.Graphics.DrawRectangle(p, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1); }
        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            var rc = new Rectangle(2, 0, e.Item.Width - 4, e.Item.Height);
            if (e.Item.Selected && e.Item.Enabled) { using (var b = new SolidBrush(hover)) e.Graphics.FillRectangle(b, rc); }
        }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? fg : dim;
            base.OnRenderItemText(e);
        }
        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            int y = e.Item.Height / 2;
            using (var p = new Pen(sep)) e.Graphics.DrawLine(p, 8, y, e.Item.Width - 8, y);
        }
        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
        {
            var r = e.ImageRectangle;
            using (var p = new Pen(fg, 2f))
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                e.Graphics.DrawLines(p, new[] { new Point(r.Left + 3, r.Top + r.Height / 2), new Point(r.Left + r.Width / 2 - 1, r.Bottom - 4), new Point(r.Right - 3, r.Top + 3) });
            }
        }
        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e) { e.ArrowColor = fg; base.OnRenderArrow(e); }
    }
    // ---- recent uploads submenu ----
    readonly List<KeyValuePair<string, string>> recent = new List<KeyValuePair<string, string>>();
    void SetRecent(List<KeyValuePair<string, string>> items)
    {
        recentItem.DropDownItems.Clear();
        if (items.Count == 0) { recentItem.DropDownItems.Add(new ToolStripMenuItem("No uploads yet") { Enabled = false }); return; }
        foreach (var kv in items)
        {
            var id = kv.Key;
            var mi = new ToolStripMenuItem(Clip(kv.Value, 48), null, (s, e) => Send("recent " + id));
            mi.ToolTipText = "Click to copy the link";
            recentItem.DropDownItems.Add(mi);
        }
    }

    static string Clip(string s, int max = 63) { return s.Length > max ? s.Substring(0, max - 1) + "…" : s; }

    void Send(string line) { lock (writeLock) { try { output.WriteLine(line); } catch { } } }

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
            uint fgPid;
            uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out fgPid), me = GetCurrentThreadId();
            if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, true);
            SetForegroundWindow(h);
            if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, false);
        }
        else
        {
            if (IsIconic(h)) ShowWindow(h, SW_SHOWNOACTIVATE);
            SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    }

    void Handle(string line)
    {
        var sp = line.IndexOf(' ');
        var cmd = sp < 0 ? line : line.Substring(0, sp);
        var arg = sp < 0 ? "" : line.Substring(sp + 1);
        switch (cmd)
        {
            case "tooltip": icon.Text = Clip(arg); break;
            case "status": statusItem.Text = Clip(arg, 60); break;
            case "icon":
            {
                var parts = arg.Split(' ');
                var state = parts[0];
                int pct = -1;
                if (state == "busy" && parts.Length > 1) int.TryParse(parts[1], out pct);
                icon.Icon = state == "busy" ? GetIcon(BUSY, pct < 0 ? 0 : pct) : state == "error" ? GetIcon(ERR, -1) : state == "paused" ? GetIcon(PAUSED, -1) : GetIcon(IDLE, -1);
                break;
            }
            case "menu-pause": pauseItem.Checked = arg == "1"; pauseItem.Text = arg == "1" ? "Resume watching" : "Pause watching"; break;
            case "menu-autostart": autostartItem.Checked = arg == "1"; break;
            case "recent-clear": recent.Clear(); SetRecent(recent); break;
            case "recent-add":
            {
                var tab = arg.IndexOf('\t');
                if (tab > 0) { recent.Add(new KeyValuePair<string, string>(arg.Substring(0, tab), arg.Substring(tab + 1))); SetRecent(recent); }
                break;
            }
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
            while ((line = input.ReadLine()) != null)
            {
                var l = line.Trim();
                if (l.Length == 0) continue;
                sync.BeginInvoke((Action)(() => Handle(l)));
            }
        }
        catch { }
        try { sync.BeginInvoke((Action)Exit); } catch { Environment.Exit(0); }
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
        if (args.Length > 1 && args[0] == "--preview")
        {   // tray.exe --preview <dir>: write the icon variants as PNGs (for checking the artwork)
            Directory.CreateDirectory(args[1]);
            var variants = new[] { new { n = "idle", c = IDLE, p = -1 }, new { n = "busy-30", c = BUSY, p = 30 }, new { n = "busy-70", c = BUSY, p = 70 }, new { n = "error", c = ERR, p = -1 }, new { n = "paused", c = PAUSED, p = -1 } };
            foreach (var v in variants) foreach (var s in new[] { 16, 32, 64 })
                File.WriteAllBytes(Path.Combine(args[1], v.n + "-" + s + ".png"), RenderPng(s, v.c, v.p));
            return;
        }
        var title = args.Length > 0 ? args[0] : "GameUploader";
        var tooltip = args.Length > 1 ? args[1] : title;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Tray(title, tooltip));
    }
}
