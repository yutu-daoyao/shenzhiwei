param([ValidateSet('capture','playback')][string]$Mode,[switch]$WaitForStart)
$ErrorActionPreference = 'Stop'
# ASCII source also works with Windows PowerShell 5.1's legacy script encoding.
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class ZhiweiAudio {
    [StructLayout(LayoutKind.Sequential, Pack=2)]
    struct Format {
        public ushort tag, channels;
        public uint rate, bytesPerSecond;
        public ushort align, bits, extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Header {
        public IntPtr data;
        public uint length, recorded;
        public UIntPtr user;
        public uint flags, loops;
        public IntPtr next;
        public UIntPtr reserved;
    }
    [DllImport("winmm.dll")] static extern uint waveInOpen(out IntPtr handle, uint device, ref Format format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] static extern uint waveInPrepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveInUnprepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveInAddBuffer(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveInStart(IntPtr handle);
    [DllImport("winmm.dll")] static extern uint waveInReset(IntPtr handle);
    [DllImport("winmm.dll")] static extern uint waveInClose(IntPtr handle);
    [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr handle, uint device, ref Format format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutUnprepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] static extern uint waveOutReset(IntPtr handle);
    [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr handle);
    static uint Size = (uint)Marshal.SizeOf(typeof(Header));
    static Format Pcm() { return new Format { tag=1, channels=1, rate=16000, bytesPerSecond=32000, align=2, bits=16 }; }
    static void Check(uint result) { if (result != 0) throw new IOException("WinMM error " + result); }
    static Header Get(IntPtr pointer) { return (Header)Marshal.PtrToStructure(pointer, typeof(Header)); }
    static IntPtr Allocate(int length) {
        var pointer = Marshal.AllocHGlobal((int)Size);
        Marshal.StructureToPtr(new Header { data=Marshal.AllocHGlobal(length), length=(uint)length }, pointer, false);
        return pointer;
    }
    static void Free(IntPtr pointer) { Marshal.FreeHGlobal(Get(pointer).data); Marshal.FreeHGlobal(pointer); }
    public static void Capture() {
        IntPtr handle; var format = Pcm();
        Check(waveInOpen(out handle, UInt32.MaxValue, ref format, IntPtr.Zero, IntPtr.Zero, 0));
        var headers = new IntPtr[8]; var output = Console.OpenStandardOutput();
        try {
            for (int i=0; i<headers.Length; i++) {
                headers[i]=Allocate(640);
                Check(waveInPrepareHeader(handle, headers[i], Size));
                Check(waveInAddBuffer(handle, headers[i], Size));
            }
            Check(waveInStart(handle)); output.WriteByte(1); output.Flush();
            var bytes = new byte[640]; int index=0;
            while (true) {
                var pointer=headers[index]; var header=Get(pointer);
                if ((header.flags & 1) == 0) { Thread.Sleep(2); continue; }
                Marshal.Copy(header.data, bytes, 0, (int)header.recorded);
                output.Write(bytes, 0, (int)header.recorded); output.Flush();
                Check(waveInAddBuffer(handle, pointer, Size));
                index=(index+1)%headers.Length;
            }
        } finally {
            waveInReset(handle);
            foreach (var pointer in headers) if (pointer != IntPtr.Zero) { waveInUnprepareHeader(handle, pointer, Size); Free(pointer); }
            waveInClose(handle);
        }
    }
    static bool Read(Stream input, byte[] bytes) {
        int offset=0;
        while (offset<bytes.Length) {
            int count=input.Read(bytes, offset, bytes.Length-offset);
            if (count==0) { if (offset==0) return false; throw new EndOfStreamException(); }
            offset+=count;
        }
        return true;
    }
    public static void Playback() {
        IntPtr handle; var format=Pcm();
        Check(waveOutOpen(out handle, UInt32.MaxValue, ref format, IntPtr.Zero, IntPtr.Zero, 0));
        var pointer=Allocate(3200); var input=Console.OpenStandardInput(); var output=Console.OpenStandardOutput();
        bool prepared=false;
        try {
            output.WriteByte(1); output.Flush(); var lengthBytes=new byte[4];
            while (Read(input, lengthBytes)) {
                int length=BitConverter.ToInt32(lengthBytes, 0);
                if (length<=0 || length>3200 || length%2!=0) throw new IOException("Invalid PCM packet");
                var bytes=new byte[length]; if (!Read(input, bytes)) throw new EndOfStreamException();
                var header=Get(pointer); header.length=(uint)length; header.flags=0;
                Marshal.StructureToPtr(header, pointer, false); Marshal.Copy(bytes, 0, header.data, length);
                Check(waveOutPrepareHeader(handle, pointer, Size)); prepared=true;
                Check(waveOutWrite(handle, pointer, Size));
                while ((Get(pointer).flags & 1)==0) Thread.Sleep(2);
                Check(waveOutUnprepareHeader(handle, pointer, Size)); prepared=false;
                output.WriteByte(1); output.Flush();
            }
        } finally {
            waveOutReset(handle);
            if (prepared) waveOutUnprepareHeader(handle, pointer, Size);
            Free(pointer); waveOutClose(handle);
        }
    }
}
'@
if($WaitForStart -and $Mode -eq 'capture'){
    $output=[Console]::OpenStandardOutput()
    $output.WriteByte(0);$output.Flush()
    if([Console]::OpenStandardInput().ReadByte() -ne 1){exit 0}
}
if ($Mode -eq 'capture') { [ZhiweiAudio]::Capture() } else { [ZhiweiAudio]::Playback() }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
