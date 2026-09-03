// GameUploader tray helper — a tray icon plus window control for the terminal window.
// Compiled on first run by the C# compiler that ships with Windows (.NET Framework), see tray.js.
//
// Protocol (one command per line):
//   stdin  (from Node):  tooltip <text> | status <text> | icon idle|error|paused | icon busy <pct>
//                        style arrow|triangle|upload|ring|letter|tile | colors <idle> <busy> <error> <paused>  (hex)
//                        menu-pause 0|1 | menu-autostart 0|1 | recent-clear | recent-add <id>\t<title>
//                        show | shownoactivate | hide | toggle | minimize | flash | seticon <ico> | query | quit
//   stdout (to Node):    click | show | copy | open | folder | pause | resume | autostart 0|1 | recent <id>
//                        style <name> | color <hex> | quit | visible 0|1 (reply to query) | ready
// The helper exits by itself when stdin closes (Node died).
//
//   tray.exe --export-icon <png> <ico> [style] [idleHex]   write the identity icon (256 px PNG + multi-size ICO)
//   tray.exe --preview <dir> [style] [idleHex]             dump every state as PNG for a visual check

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
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
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    delegate bool EnumProc(IntPtr h, IntPtr lp);
    const uint WM_SETICON = 0x80;

    const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9;
    const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;

    // Defaults (the app sends its config over the pipe right after "ready")
    public static readonly string[] STYLES = { "arrow", "triangle", "upload", "ring", "letter", "tile" };
    public static readonly string[] STYLE_LABELS = { "Arrow", "Triangle", "Triangle with base", "Ring (fills with progress)", "Letter G", "Tile" };
    public static readonly string[][] COLORS = {
        new[] { "Pink", "#D4537E" }, new[] { "White", "#F0F0F0" }, new[] { "Cyan", "#2D96AA" }, new[] { "Green", "#40C070" },
        new[] { "Orange", "#EF9F27" }, new[] { "Purple", "#7F77DD" }, new[] { "Red", "#E24B4A" } };
    static readonly Color TILE_DARK = Color.FromArgb(0, 0, 0);

    string style = "arrow";
    Color idleC = Hex("#D4537E"), busyC = Hex("#40C070"), errC = Hex("#E24B4A"), pausedC = Hex("#888780");
    string curState = "idle"; int curPct = -1;

    readonly string windowTitle;
    readonly NotifyIcon icon;
    readonly ContextMenuStrip menu;
    readonly ToolStripMenuItem statusItem, pauseItem, autostartItem, recentItem, styleItem, colorItem;
    readonly Dictionary<string, Icon> iconCache = new Dictionary<string, Icon>();
    readonly List<Icon> keepIcons = new List<Icon>();
    readonly Control sync;
    readonly object writeLock = new object();
    IntPtr hwnd = IntPtr.Zero;
    // No console in a winexe: talk to Node over the raw stdin/stdout pipes, UTF-8, no BOM.
    static readonly TextReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    static readonly TextWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

    static Color Hex(string s)
    {
        try { s = s.Trim().TrimStart('#'); if (s.Length == 6) return Color.FromArgb(Convert.ToInt32(s.Substring(0, 2), 16), Convert.ToInt32(s.Substring(2, 2), 16), Convert.ToInt32(s.Substring(4, 2), 16)); }
        catch { }
        return Color.Magenta;
    }
    static string ToHex(Color c) { return "#" + c.R.ToString("X2") + c.G.ToString("X2") + c.B.ToString("X2"); }

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
        Sub(recentItem);
        menu.Items.Add(recentItem);
        menu.Items.Add(new ToolStripMenuItem("Open watch folder", null, (s, e) => Send("folder")));
        menu.Items.Add(new ToolStripSeparator());
        pauseItem = new ToolStripMenuItem("Pause watching", null, (s, e) => Send(pauseItem.Checked ? "resume" : "pause"));
        menu.Items.Add(pauseItem);
        autostartItem = new ToolStripMenuItem("Start with Windows", null, (s, e) => Send("autostart " + (autostartItem.Checked ? "0" : "1")));
        menu.Items.Add(autostartItem);
        menu.Items.Add(new ToolStripSeparator());
        styleItem = new ToolStripMenuItem("Icon");
        Sub(styleItem);
        for (int i = 0; i < STYLES.Length; i++) { var st = STYLES[i]; styleItem.DropDownItems.Add(new ToolStripMenuItem(STYLE_LABELS[i], null, (s, e) => Send("style " + st)) { Tag = st }); }
        menu.Items.Add(styleItem);
        colorItem = new ToolStripMenuItem("Color");
        Sub(colorItem);
        foreach (var c in COLORS) { var hex = c[1]; colorItem.DropDownItems.Add(new ToolStripMenuItem(c[0], null, (s, e) => Send("color " + hex)) { Tag = hex.ToUpperInvariant() }); }
        menu.Items.Add(colorItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit", null, (s, e) => Send("quit")));
        SetRecent(new List<KeyValuePair<string, string>>());
        SyncChecks();

        icon = new NotifyIcon { Icon = CurrentIcon(), Text = Clip(tooltip), ContextMenuStrip = menu, Visible = true };
        icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Send("click"); };
        icon.DoubleClick += (s, e) => Send("show");

        var reader = new Thread(ReadLoop) { IsBackground = true };
        reader.Start();
        Send("ready");
    }

    void Sub(ToolStripMenuItem item) { item.DropDown.Renderer = menu.Renderer; item.DropDown.Font = menu.Font; ((ToolStripDropDownMenu)item.DropDown).ShowImageMargin = false; ((ToolStripDropDownMenu)item.DropDown).ShowCheckMargin = true; }

    void SyncChecks()
    {
        foreach (ToolStripMenuItem mi in styleItem.DropDownItems) mi.Checked = (string)mi.Tag == style;
        var cur = ToHex(idleC).ToUpperInvariant();
        foreach (ToolStripMenuItem mi in colorItem.DropDownItems) mi.Checked = (string)mi.Tag == cur;
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

    // ---- icons ----
    Icon CurrentIcon()
    {
        Color c = curState == "busy" ? busyC : curState == "error" ? errC : curState == "paused" ? pausedC : idleC;
        int pct = curState == "busy" ? Math.Max(0, curPct) : -1;
        int bucket = pct < 0 ? -1 : (pct / 10) * 10;
        string key = style + ":" + c.ToArgb() + ":" + bucket;
        Icon ic;
        if (iconCache.TryGetValue(key, out ic)) return ic;
        ic = BuildIcon(style, c, bucket, null);
        iconCache[key] = ic;
        return ic;
    }

    static Icon BuildIcon(string style, Color c, int pct, int[] sizes)
    {
        if (sizes == null) sizes = new[] { 16, 20, 24, 32 };
        var pngs = new List<byte[]>();
        foreach (var s in sizes) pngs.Add(RenderPng(s, style, c, pct));
        using (var ms = new MemoryStream())
        using (var w = new BinaryWriter(ms))
        {
            w.Write((short)0); w.Write((short)1); w.Write((short)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i])); w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
                w.Write((byte)0); w.Write((byte)0); w.Write((short)1); w.Write((short)32);
                w.Write(pngs[i].Length); w.Write(offset);
                offset += pngs[i].Length;
            }
            foreach (var p in pngs) w.Write(p);
            ms.Position = 0;
            return new Icon(ms);
        }
    }

    // One state of one style at one size. pct >= 0 = uploading: flat glyphs fill bottom-up with the color
    // (dim silhouette behind), the ring draws an arc, the tile fills.
    static byte[] RenderPng(int size, string style, Color c, int pct)
    {
        using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                float s = size;
                if (style == "tile")
                {
                    var tile = RoundedRect(new RectangleF(0.5f, 0.5f, s - 1, s - 1), s * 0.22f);
                    if (pct < 0) { using (var b = new SolidBrush(c)) g.FillPath(b, tile); }
                    else
                    {
                        using (var b = new SolidBrush(TILE_DARK)) g.FillPath(b, tile);
                        float h = (s - 1) * Math.Max(0.08f, pct / 100f);
                        g.SetClip(tile);
                        using (var b = new SolidBrush(c)) g.FillRectangle(b, 0, s - h, s, h);
                        g.ResetClip();
                    }
                    using (var wb = new SolidBrush(Color.White))
                        g.FillPolygon(wb, new[] { new PointF(s * 0.5f, s * 0.22f), new PointF(s * 0.8f, s * 0.74f), new PointF(s * 0.2f, s * 0.74f) });
                }
                else if (style == "ring")
                {
                    float w = Math.Max(1.5f, s / 7f);
                    var rect = new RectangleF(w / 2 + 0.5f, w / 2 + 0.5f, s - w - 1, s - w - 1);
                    using (var rp = new Pen(c, w))
                    {
                        if (pct < 0) g.DrawEllipse(rp, rect);
                        else { using (var dim = new Pen(Color.FromArgb(70, c), w)) g.DrawEllipse(dim, rect); if (pct > 0) g.DrawArc(rp, rect, -90, 360f * pct / 100f); }
                    }
                    DrawArrow(g, s, c, 0.34f, 0.5f, 0.32f, 0.70f, Math.Max(1.5f, s / 9f), false);
                }
                else
                {
                    // flat silhouettes: draw dim + clipped full-color for progress, or just full color
                    if (pct < 0) DrawFlat(g, s, style, c);
                    else
                    {
                        DrawFlat(g, s, style, Color.FromArgb(75, c));
                        float h = s * Math.Max(0.06f, pct / 100f);
                        g.SetClip(new RectangleF(0, s - h, s, h));
                        DrawFlat(g, s, style, c);
                        g.ResetClip();
                    }
                }
            }
            using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
        }
    }

    static void DrawFlat(Graphics g, float s, string style, Color c)
    {
        using (var b = new SolidBrush(c))
        {
            if (style == "arrow")
            {
                DrawArrow(g, s, c, 0.22f, 0.78f, 0.15f, 0.66f, Math.Max(1.5f, s / 8f), true);
                using (var p = new Pen(c, Math.Max(1.5f, s / 8f)) { StartCap = LineCap.Round, EndCap = LineCap.Round }) g.DrawLine(p, s * 0.18f, s * 0.88f, s * 0.82f, s * 0.88f);
            }
            else if (style == "triangle")
                g.FillPolygon(b, new[] { new PointF(s * 0.5f, s * 0.1f), new PointF(s * 0.92f, s * 0.86f), new PointF(s * 0.08f, s * 0.86f) });
            else if (style == "upload")
            {
                g.FillPolygon(b, new[] { new PointF(s * 0.5f, s * 0.08f), new PointF(s * 0.9f, s * 0.66f), new PointF(s * 0.1f, s * 0.66f) });
                g.FillRectangle(b, s * 0.1f, s * 0.78f, s * 0.8f, Math.Max(1.5f, s * 0.13f));
            }
            else if (style == "letter")
            {
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                using (var f = new Font("Segoe UI", s * 0.62f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    g.DrawString("G", f, b, new RectangleF(0, 0, s, s * 1.02f), sf);
            }
            else DrawFlat(g, s, "arrow", c);
        }
    }

    // chevron + stem: xl/xr = chevron ends, yt = tip, yb = stem bottom (all fractions of size)
    static void DrawArrow(Graphics g, float s, Color c, float xl, float xr, float yt, float yb, float width, bool bigStem)
    {
        using (var p = new Pen(c, width) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
        {
            float ych = yt + (xr - xl) * 0.55f;
            g.DrawLines(p, new[] { new PointF(s * xl, s * ych), new PointF(s * 0.5f, s * yt), new PointF(s * xr, s * ych) });
            g.DrawLine(p, s * 0.5f, s * (yt + 0.02f), s * 0.5f, s * yb);
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
        readonly Color bg, fg, dim, hover, sep;
        public MenuRenderer(bool dark) : base(new ProfessionalColorTable { UseSystemColors = false })
        {
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
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) { e.TextColor = e.Item.Enabled ? fg : dim; base.OnRenderItemText(e); }
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
                curState = parts[0];
                curPct = -1;
                if (curState == "busy" && parts.Length > 1) int.TryParse(parts[1], out curPct);
                icon.Icon = CurrentIcon();
                break;
            }
            case "style":
                if (Array.IndexOf(STYLES, arg) >= 0) { style = arg; iconCache.Clear(); icon.Icon = CurrentIcon(); SyncChecks(); }
                break;
            case "colors":
            {
                var p = arg.Split(' ');
                if (p.Length >= 1) idleC = Hex(p[0]);
                if (p.Length >= 2) busyC = Hex(p[1]);
                if (p.Length >= 3) errC = Hex(p[2]);
                if (p.Length >= 4) pausedC = Hex(p[3]);
                iconCache.Clear(); icon.Icon = CurrentIcon(); SyncChecks();
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
            case "seticon":
            {   // seticon <path.ico>: stamp our icon onto the terminal window (title bar + taskbar)
                var h = FindWindow();
                if (h != IntPtr.Zero && File.Exists(arg))
                {
                    try
                    {
                        var big = new Icon(arg, 32, 32); var small = new Icon(arg, 16, 16);
                        keepIcons.Add(big); keepIcons.Add(small);
                        SendMessage(h, WM_SETICON, (IntPtr)1, big.Handle);
                        SendMessage(h, WM_SETICON, (IntPtr)0, small.Handle);
                    }
                    catch { }
                }
                break;
            }
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
        if (args.Length > 2 && args[0] == "--export-icon")
        {   // tray.exe --export-icon <png> <ico> [style] [idleHex]
            var st = args.Length > 3 ? args[3] : "arrow"; var col = Hex(args.Length > 4 ? args[4] : "#D4537E");
            File.WriteAllBytes(args[1], RenderPng(256, st, col, -1));
            using (var ic = BuildIcon(st, col, -1, new[] { 16, 24, 32, 48, 64, 128, 256 }))
            using (var fs = File.Create(args[2])) ic.Save(fs);
            return;
        }
        if (args.Length > 1 && args[0] == "--preview")
        {   // tray.exe --preview <dir> [style] [idleHex]: every state as PNG
            var st = args.Length > 2 ? args[2] : "arrow"; var col = Hex(args.Length > 3 ? args[3] : "#D4537E");
            Directory.CreateDirectory(args[1]);
            var variants = new[] { new { n = "idle", c = col, p = -1 }, new { n = "busy-30", c = Hex("#40C070"), p = 30 }, new { n = "busy-70", c = Hex("#40C070"), p = 70 }, new { n = "error", c = Hex("#E24B4A"), p = -1 }, new { n = "paused", c = Hex("#888780"), p = -1 } };
            foreach (var v in variants) foreach (var s in new[] { 16, 32, 64 })
                File.WriteAllBytes(Path.Combine(args[1], v.n + "-" + s + ".png"), RenderPng(s, st, v.c, v.p));
            return;
        }
        var title = args.Length > 0 ? args[0] : "GameUploader";
        var tooltip = args.Length > 1 ? args[1] : title;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Tray(title, tooltip));
    }
}
