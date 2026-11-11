using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class ZhiweiDesktopRing : Form {
    [DllImport("user32.dll", SetLastError=true)] static extern bool RegisterHotKey(IntPtr h, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    public readonly ConcurrentQueue<string> Actions = new ConcurrentQueue<string>();
    readonly Timer clock = new Timer();
    readonly Image artwork;
    readonly Font caption = new Font("Microsoft YaHei UI", 9);
    string state="hidden", text="";
    bool registered, held, closing;
    int phase, heldTicks, lifetime;
    float level;
    public ZhiweiDesktopRing(string asset) {
        Text="Shenzhiwei background voice";
        FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; TopMost=true;
        BackColor=Color.Magenta; TransparencyKey=Color.Magenta;
        Size=new Size(302,174); DoubleBuffered=true;
        if(System.IO.File.Exists(asset))artwork=Image.FromFile(asset);
        clock.Interval=33;clock.Tick+=Tick;clock.Start();
        IntPtr unused=Handle;
    }
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {
        get {var cp=base.CreateParams;cp.ExStyle|=0x08000000|0x00000080|0x00000020;return cp;}
    }
    protected override void WndProc(ref Message m) {
        if(m.Msg==0x0021){m.Result=new IntPtr(3);return;}
        if(m.Msg==0x0084){m.Result=new IntPtr(-1);return;}
        if(m.Msg==0x0312&&m.WParam.ToInt32()==17){
            if(!held){held=true;heldTicks=0;Actions.Enqueue("{\"type\":\"hotkey\",\"action\":\"start\",\"windowId\":\""+GetForegroundWindow().ToInt64()+"\"}");}
            return;
        }
        base.WndProc(ref m);
    }
    public bool Configure(bool enabled) {
        if(registered){UnregisterHotKey(Handle,17);registered=false;}
        if(held){held=false;Actions.Enqueue("{\"type\":\"hotkey\",\"action\":\"cancel\"}");}
        if(enabled)registered=RegisterHotKey(Handle,17,0x4002,0x20);
        return !enabled||registered;
    }
    public void UpdateState(string next,string value,double amplitude) {
        state=next??"hidden";text=value??"";level=(float)Math.Max(0,Math.Min(1,amplitude));lifetime=0;
        if(state=="hidden"){Hide();return;}
        if(!Visible){
            var area=Screen.FromHandle(GetForegroundWindow()).WorkingArea;
            SetBounds(area.Right-Width-22,area.Bottom-Height-18,Width,Height);
            Show();
            SetWindowPos(Handle,new IntPtr(-1),Left,Top,Width,Height,0x0010|0x0040);
        }
        Invalidate();
    }
    void Tick(object sender,EventArgs e) {
        if(closing)return;
        phase++;lifetime++;
        if(held){
            heldTicks++;
            if(heldTicks>1818){held=false;Actions.Enqueue("{\"type\":\"hotkey\",\"action\":\"cancel\"}");}
            else if((GetAsyncKeyState(0x11)&0x8000)==0||(GetAsyncKeyState(0x20)&0x8000)==0){
                held=false;Actions.Enqueue("{\"type\":\"hotkey\",\"action\":\"stop\"}");
            }
        }
        if(Visible){
            if(state=="error"&&lifetime>180){Hide();return;}
            Invalidate();
        }
    }
    protected override void OnPaint(PaintEventArgs e) {
        var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.InterpolationMode=InterpolationMode.HighQualityBicubic;
        float breath=(float)(Math.Sin(phase*.06)*2+level*6);
        var ring=new RectangleF(99-breath,12-breath,110+breath*2,79+breath*2);
        if(artwork!=null){
            float fit=Math.Min(ring.Width/artwork.Width,ring.Height/artwork.Height);
            g.DrawImage(artwork,ring.X+(ring.Width-artwork.Width*fit)/2,ring.Y+(ring.Height-artwork.Height*fit)/2,artwork.Width*fit,artwork.Height*fit);
        }else using(var pen=new Pen(Color.FromArgb(224,202,160),2))g.DrawBezier(pen,104,33,220,0,80,100,205,40);
        string label=text.Length>90?text.Substring(0,90)+"…":text;
        var size=TextRenderer.MeasureText(label,caption,new Size(270,64),TextFormatFlags.WordBreak);
        int h=Math.Min(70,size.Height+14),y=98;
        using(var brush=new SolidBrush(Color.FromArgb(11,26,38)))g.FillRoundedRectangle(brush,new Rectangle(10,y,282,h),10);
        TextRenderer.DrawText(g,label,caption,new Rectangle(20,y+6,262,h-12),state=="error"?Color.FromArgb(235,176,154):Color.FromArgb(214,225,232),TextFormatFlags.WordBreak|TextFormatFlags.HorizontalCenter|TextFormatFlags.NoPadding);
    }
    protected override void Dispose(bool disposing) {
        if(disposing){closing=true;clock.Stop();clock.Dispose();if(registered)UnregisterHotKey(Handle,17);caption.Dispose();if(artwork!=null)artwork.Dispose();}
        base.Dispose(disposing);
    }
}
public static class ZhiweiDrawing {
    public static void FillRoundedRectangle(this Graphics graphics,Brush brush,Rectangle bounds,int radius){
        using(var p=new GraphicsPath()){
            int d=radius*2;
            p.AddArc(bounds.X,bounds.Y,d,d,180,90);p.AddArc(bounds.Right-d,bounds.Y,d,d,270,90);
            p.AddArc(bounds.Right-d,bounds.Bottom-d,d,d,0,90);p.AddArc(bounds.X,bounds.Bottom-d,d,d,90,90);
            p.CloseFigure();graphics.FillPath(brush,p);
        }
    }
}
