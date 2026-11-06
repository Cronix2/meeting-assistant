// LoopbackMixer — capture en loopback (WASAPI) plusieurs sorties audio Windows en même temps,
// les mixe, et écrit sur stdout du PCM 16 kHz mono 16 bits little-endian (chunks de 100 ms = 3200 octets).
//
//   LoopbackMixer.exe --list
//       -> affiche sur stdout un tableau JSON des sorties actives : [{"id":"...","name":"...","isDefault":true}, ...]
//   LoopbackMixer.exe --capture <idSortie1> [<idSortie2> ...]
//       -> stdout : audio PCM brut ; stderr : événements JSON (une ligne chacun) :
//          {"type":"ready","devices":["..."]}  {"type":"level","mix":0.01,"devices":[{"name":"..","rms":0.01}]}
//          {"type":"warn","message":".."}      {"type":"error","message":".."}
//
// Le processus s'arrête quand stdin est fermé (processus parent terminé).
// Compatible C# 5 : se compile avec csc.exe fourni avec Windows (.NET Framework 4.x), sans rien installer.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DeskAssistant
{
    // ---------------------------------------------------------------------
    // Interop COM (Core Audio)
    // ---------------------------------------------------------------------

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject
    {
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrameCount);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey
    {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropVariant
    {
        public ushort vt;
        public ushort reserved1;
        public ushort reserved2;
        public ushort reserved3;
        public IntPtr ptr;
        public IntPtr ptr2;
    }

    // ---------------------------------------------------------------------
    // Utilitaires
    // ---------------------------------------------------------------------

    static class Util
    {
        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref PropVariant pv);

        static readonly object errLock = new object();
        static Stream errStream;

        public static void InitErr()
        {
            errStream = Console.OpenStandardError();
        }

        public static string Esc(string s)
        {
            if (s == null) return "";
            StringBuilder sb = new StringBuilder();
            foreach (char c in s)
            {
                if (c == '\\') sb.Append("\\\\");
                else if (c == '"') sb.Append("\\\"");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < ' ') sb.Append(' ');
                else sb.Append(c);
            }
            return sb.ToString();
        }

        public static string Num(double v)
        {
            return v.ToString("0.00000", CultureInfo.InvariantCulture);
        }

        /// <summary>Écrit une ligne JSON sur stderr (UTF-8, sans BOM).</summary>
        public static void Event(string json)
        {
            try
            {
                byte[] b = new UTF8Encoding(false).GetBytes(json + "\n");
                lock (errLock)
                {
                    if (errStream == null) errStream = Console.OpenStandardError();
                    errStream.Write(b, 0, b.Length);
                    errStream.Flush();
                }
            }
            catch (Exception)
            {
            }
        }

        public static void Warn(string message)
        {
            Event("{\"type\":\"warn\",\"message\":\"" + Esc(message) + "\"}");
        }

        public static void Error(string message)
        {
            Event("{\"type\":\"error\",\"message\":\"" + Esc(message) + "\"}");
        }

        public static string FriendlyName(IMMDevice device)
        {
            IPropertyStore store;
            if (device.OpenPropertyStore(0, out store) != 0 || store == null) return "(sans nom)";
            try
            {
                PropertyKey key = new PropertyKey();
                key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); // PKEY_Device_FriendlyName
                key.pid = 14;
                PropVariant pv;
                if (store.GetValue(ref key, out pv) != 0) return "(sans nom)";
                string name = null;
                if (pv.vt == 31 && pv.ptr != IntPtr.Zero) name = Marshal.PtrToStringUni(pv.ptr); // VT_LPWSTR
                PropVariantClear(ref pv);
                return string.IsNullOrEmpty(name) ? "(sans nom)" : name;
            }
            finally
            {
                Marshal.ReleaseComObject(store);
            }
        }
    }

    // ---------------------------------------------------------------------
    // Capture loopback d'une sortie, convertie en 16 kHz mono (flottants)
    // ---------------------------------------------------------------------

    class DeviceCapture
    {
        const int OutRate = 16000;
        const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        const int CLSCTX_ALL = 23;

        public readonly string Id;
        public readonly string Name;

        IMMDevice device;
        IAudioClient client;
        IAudioCaptureClient capture;
        Thread thread;
        volatile bool running;

        int channels;
        int rate;
        int bits;
        bool isFloat;

        // Rééchantillonnage : échantillons mono à la fréquence de la sortie + position fractionnaire.
        readonly List<float> src = new List<float>();
        double pos;

        // File d'attente (déjà en 16 kHz mono) lue par le mixeur.
        readonly object sync = new object();
        readonly List<float> fifo = new List<float>();
        bool primed;
        int prevCount;

        public DeviceCapture(IMMDevice device, string id, string name)
        {
            this.device = device;
            this.Id = id;
            this.Name = name;
        }

        public void Start()
        {
            Guid iidClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
            object o;
            int hr = device.Activate(ref iidClient, CLSCTX_ALL, IntPtr.Zero, out o);
            if (hr != 0) throw new Exception("Activate a échoué (0x" + hr.ToString("X8") + ")");
            client = (IAudioClient)o;

            IntPtr fmt;
            hr = client.GetMixFormat(out fmt);
            if (hr != 0) throw new Exception("GetMixFormat a échoué (0x" + hr.ToString("X8") + ")");
            try
            {
                int tag = Marshal.ReadInt16(fmt, 0) & 0xFFFF;
                channels = Marshal.ReadInt16(fmt, 2);
                rate = Marshal.ReadInt32(fmt, 4);
                bits = Marshal.ReadInt16(fmt, 14);
                isFloat = (tag == 3);
                if (tag == 0xFFFE)
                {
                    // WAVEFORMATEXTENSIBLE : le début du GUID SubFormat (offset 24) vaut 1 (PCM) ou 3 (float).
                    int sub = Marshal.ReadInt32(fmt, 24);
                    isFloat = (sub == 3);
                }
                if (channels < 1 || rate < 8000) throw new Exception("format audio inattendu");
                if (!(isFloat && bits == 32) && !(!isFloat && (bits == 16 || bits == 24 || bits == 32)))
                    throw new Exception("format non géré (" + bits + " bits" + (isFloat ? " float" : "") + ")");

                // Loopback : STREAMFLAGS_LOOPBACK en mode partagé, tampon de 200 ms, lecture par polling.
                hr = client.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000L, 0L, fmt, IntPtr.Zero);
                if (hr != 0) throw new Exception("Initialize (loopback) a échoué (0x" + hr.ToString("X8") + ")");
            }
            finally
            {
                Marshal.FreeCoTaskMem(fmt);
            }

            Guid iidCapture = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
            object svc;
            hr = client.GetService(ref iidCapture, out svc);
            if (hr != 0) throw new Exception("GetService a échoué (0x" + hr.ToString("X8") + ")");
            capture = (IAudioCaptureClient)svc;

            hr = client.Start();
            if (hr != 0) throw new Exception("Start a échoué (0x" + hr.ToString("X8") + ")");

            running = true;
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Start();
        }

        public void Stop()
        {
            running = false;
            try
            {
                if (thread != null) thread.Join(500);
                if (client != null) client.Stop();
            }
            catch (Exception)
            {
            }
        }

        void Run()
        {
            while (running)
            {
                try
                {
                    uint packet;
                    int hr = capture.GetNextPacketSize(out packet);
                    if (hr != 0)
                    {
                        Util.Warn(Name + " : GetNextPacketSize a échoué (0x" + hr.ToString("X8") + ")");
                        Thread.Sleep(200);
                        continue;
                    }
                    if (packet == 0)
                    {
                        Thread.Sleep(5);
                        continue;
                    }
                    while (packet > 0 && running)
                    {
                        IntPtr data;
                        uint frames;
                        uint flags;
                        ulong devPos;
                        ulong qpcPos;
                        hr = capture.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos);
                        if (hr != 0) break; // 0x08890001 = tampon vide (succès non nul)
                        bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                        Consume(data, (int)frames, silent);
                        capture.ReleaseBuffer(frames);
                        hr = capture.GetNextPacketSize(out packet);
                        if (hr != 0) break;
                    }
                }
                catch (Exception ex)
                {
                    Util.Warn(Name + " : " + ex.Message);
                    Thread.Sleep(200);
                }
            }
        }

        // Convertit un paquet en mono flottant puis l'ajoute au rééchantillonneur.
        void Consume(IntPtr data, int frames, bool silent)
        {
            float[] mono = new float[frames];
            if (!silent && data != IntPtr.Zero)
            {
                int total = frames * channels;
                if (isFloat)
                {
                    float[] buf = new float[total];
                    Marshal.Copy(data, buf, 0, total);
                    for (int i = 0; i < frames; i++) mono[i] = Downmix(buf, i * channels);
                }
                else if (bits == 16)
                {
                    short[] raw = new short[total];
                    Marshal.Copy(data, raw, 0, total);
                    float[] buf = new float[total];
                    for (int i = 0; i < total; i++) buf[i] = raw[i] / 32768f;
                    for (int i = 0; i < frames; i++) mono[i] = Downmix(buf, i * channels);
                }
                else if (bits == 32)
                {
                    int[] raw = new int[total];
                    Marshal.Copy(data, raw, 0, total);
                    float[] buf = new float[total];
                    for (int i = 0; i < total; i++) buf[i] = raw[i] / 2147483648f;
                    for (int i = 0; i < frames; i++) mono[i] = Downmix(buf, i * channels);
                }
                else // 24 bits
                {
                    byte[] raw = new byte[total * 3];
                    Marshal.Copy(data, raw, 0, raw.Length);
                    float[] buf = new float[total];
                    for (int i = 0; i < total; i++)
                    {
                        int v = (raw[i * 3] << 8) | (raw[i * 3 + 1] << 16) | (raw[i * 3 + 2] << 24);
                        buf[i] = v / 2147483648f;
                    }
                    for (int i = 0; i < frames; i++) mono[i] = Downmix(buf, i * channels);
                }
            }
            Resample(mono);
        }

        // Avant gauche + avant droit (+ centre s'il existe), en mono.
        float Downmix(float[] buf, int offset)
        {
            float l = buf[offset];
            float r = channels > 1 ? buf[offset + 1] : l;
            float m = (l + r) * 0.5f;
            if (channels >= 3) m += 0.5f * buf[offset + 2];
            return m;
        }

        // Moyenne par boîte vers 16 kHz (anti-repliement simple), avec report de la position fractionnaire.
        void Resample(float[] mono)
        {
            src.AddRange(mono);
            double step = (double)rate / OutRate;
            List<float> produced = new List<float>();
            int n = src.Count;
            while (true)
            {
                int i0 = (int)pos;
                int i1 = (int)(pos + step);
                if (i1 <= i0) i1 = i0 + 1;
                if (i1 > n) break;
                float sum = 0f;
                for (int i = i0; i < i1; i++) sum += src[i];
                produced.Add(sum / (i1 - i0));
                pos += step;
            }
            int drop = (int)pos;
            if (drop > 0)
            {
                if (drop > src.Count) drop = src.Count;
                src.RemoveRange(0, drop);
                pos -= drop;
            }
            if (produced.Count > 0)
            {
                lock (sync)
                {
                    fifo.AddRange(produced);
                    // Garde-fou : jamais plus de ~400 ms de retard.
                    if (fifo.Count > 6400) fifo.RemoveRange(0, fifo.Count - 3200);
                }
            }
        }

        /// <summary>
        /// Ajoute dans `mix` jusqu'à n échantillons de cette sortie (tampon anti-gigue de ~150 ms).
        /// Retourne la somme des carrés ajoutés (pour calculer le niveau).
        /// </summary>
        public double TakeInto(float[] mix, int n)
        {
            const int Prime = 2400; // 150 ms
            lock (sync)
            {
                int count = fifo.Count;
                bool play = false;
                if (!primed)
                {
                    if (count >= Prime) primed = true;
                    else if (count > 0 && count == prevCount) play = true; // plus rien n'arrive : on vide la fin du son
                }
                if (primed) play = true;

                double sumsq = 0;
                if (play)
                {
                    int take = Math.Min(n, fifo.Count);
                    for (int i = 0; i < take; i++)
                    {
                        float s = fifo[i];
                        mix[i] += s;
                        sumsq += (double)s * s;
                    }
                    fifo.RemoveRange(0, take);
                    if (fifo.Count == 0) primed = false;
                }
                prevCount = fifo.Count;
                return sumsq;
            }
        }

        public void Release()
        {
            try
            {
                if (capture != null) Marshal.ReleaseComObject(capture);
                if (client != null) Marshal.ReleaseComObject(client);
                if (device != null) Marshal.ReleaseComObject(device);
            }
            catch (Exception)
            {
            }
        }
    }

    // ---------------------------------------------------------------------
    // Programme
    // ---------------------------------------------------------------------

    static class Program
    {
        static volatile bool stop;

        static int Main(string[] args)
        {
            try
            {
                if (args.Length >= 1 && args[0] == "--list") return ListDevices();
                if (args.Length >= 2 && args[0] == "--capture") return CaptureAll(args);
                Util.Error("usage : LoopbackMixer --list | --capture <idSortie> [...]");
                return 1;
            }
            catch (Exception ex)
            {
                Util.Error(ex.Message);
                return 3;
            }
        }

        static IMMDeviceEnumerator NewEnumerator()
        {
            return (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        }

        static int ListDevices()
        {
            IMMDeviceEnumerator en = NewEnumerator();

            string defaultId = null;
            IMMDevice defDev;
            if (en.GetDefaultAudioEndpoint(0, 1, out defDev) == 0 && defDev != null)
            {
                defDev.GetId(out defaultId);
            }

            IMMDeviceCollection col;
            int hr = en.EnumAudioEndpoints(0, 1, out col); // eRender, DEVICE_STATE_ACTIVE
            if (hr != 0)
            {
                Util.Error("EnumAudioEndpoints a échoué (0x" + hr.ToString("X8") + ")");
                return 2;
            }
            uint count;
            col.GetCount(out count);

            StringBuilder sb = new StringBuilder();
            sb.Append("[");
            for (uint i = 0; i < count; i++)
            {
                IMMDevice d;
                if (col.Item(i, out d) != 0 || d == null) continue;
                string id;
                d.GetId(out id);
                string name = Util.FriendlyName(d);
                if (sb.Length > 1) sb.Append(",");
                sb.Append("{\"id\":\"").Append(Util.Esc(id)).Append("\",\"name\":\"").Append(Util.Esc(name));
                sb.Append("\",\"isDefault\":").Append(id == defaultId ? "true" : "false").Append("}");
            }
            sb.Append("]");

            byte[] bytes = new UTF8Encoding(false).GetBytes(sb.ToString() + "\n");
            Stream o = Console.OpenStandardOutput();
            o.Write(bytes, 0, bytes.Length);
            o.Flush();
            return 0;
        }

        static int CaptureAll(string[] args)
        {
            IMMDeviceEnumerator en = NewEnumerator();
            List<DeviceCapture> devices = new List<DeviceCapture>();

            for (int i = 1; i < args.Length; i++)
            {
                string id = args[i];
                try
                {
                    IMMDevice d;
                    int hr = en.GetDevice(id, out d);
                    if (hr != 0 || d == null) throw new Exception("sortie introuvable (0x" + hr.ToString("X8") + ")");
                    DeviceCapture dc = new DeviceCapture(d, id, Util.FriendlyName(d));
                    dc.Start();
                    devices.Add(dc);
                }
                catch (Exception ex)
                {
                    Util.Warn("Sortie ignorée « " + id + " » : " + ex.Message);
                }
            }

            if (devices.Count == 0)
            {
                Util.Error("aucune sortie audio n'a pu être ouverte en loopback");
                return 2;
            }

            StringBuilder names = new StringBuilder();
            foreach (DeviceCapture dc in devices)
            {
                if (names.Length > 0) names.Append(",");
                names.Append("\"").Append(Util.Esc(dc.Name)).Append("\"");
            }
            Util.Event("{\"type\":\"ready\",\"devices\":[" + names.ToString() + "]}");

            // Arrêt propre quand le processus parent ferme stdin.
            Thread watcher = new Thread(delegate ()
            {
                try
                {
                    Stream stdin = Console.OpenStandardInput();
                    byte[] buf = new byte[64];
                    while (stdin.Read(buf, 0, buf.Length) > 0)
                    {
                    }
                }
                catch (Exception)
                {
                }
                stop = true;
            });
            watcher.IsBackground = true;
            watcher.Start();

            const int ChunkSamples = 1600; // 100 ms à 16 kHz
            Stream stdout = Console.OpenStandardOutput();
            float[] mix = new float[ChunkSamples];
            byte[] outBuf = new byte[ChunkSamples * 2];
            double[] devSumsq = new double[devices.Count];
            double mixSumsq = 0;
            long samplesSinceStats = 0;
            Stopwatch clock = Stopwatch.StartNew();
            long tick = 0;

            while (!stop)
            {
                long target = (tick + 1) * 100;
                while (!stop && clock.ElapsedMilliseconds < target) Thread.Sleep(2);
                if (stop) break;
                tick++;

                Array.Clear(mix, 0, mix.Length);
                for (int d = 0; d < devices.Count; d++)
                {
                    devSumsq[d] += devices[d].TakeInto(mix, ChunkSamples);
                }
                for (int i = 0; i < ChunkSamples; i++)
                {
                    float s = mix[i];
                    if (s > 1f) s = 1f;
                    else if (s < -1f) s = -1f;
                    mixSumsq += (double)s * s;
                    short v = (short)(s * 32767f);
                    outBuf[i * 2] = (byte)(v & 0xFF);
                    outBuf[i * 2 + 1] = (byte)((v >> 8) & 0xFF);
                }
                samplesSinceStats += ChunkSamples;

                try
                {
                    stdout.Write(outBuf, 0, outBuf.Length);
                    stdout.Flush();
                }
                catch (Exception)
                {
                    break; // le parent a fermé le tube
                }

                if (tick % 5 == 0)
                {
                    StringBuilder sb = new StringBuilder();
                    sb.Append("{\"type\":\"level\",\"mix\":").Append(Util.Num(Math.Sqrt(mixSumsq / samplesSinceStats)));
                    sb.Append(",\"devices\":[");
                    for (int d = 0; d < devices.Count; d++)
                    {
                        if (d > 0) sb.Append(",");
                        sb.Append("{\"name\":\"").Append(Util.Esc(devices[d].Name)).Append("\",\"rms\":");
                        sb.Append(Util.Num(Math.Sqrt(devSumsq[d] / samplesSinceStats))).Append("}");
                        devSumsq[d] = 0;
                    }
                    sb.Append("]}");
                    Util.Event(sb.ToString());
                    mixSumsq = 0;
                    samplesSinceStats = 0;
                }
            }

            foreach (DeviceCapture dc in devices) dc.Stop();
            foreach (DeviceCapture dc in devices) dc.Release();
            return 0;
        }
    }
}
