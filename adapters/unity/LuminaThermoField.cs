// lumina-physics · Temperature / fuel / moisture field: fire spread, charring, steam (spec 12).
//
// Port of modules/thermo/thermo.ts. A small grid over a patch of ground (the transform's XZ
// position is its centre) stepped at 20 Hz:
//   combustion  fuel above 280 C burns unless it is soaked, heating toward 950 C
//   spread      conduction + radiant pre-heating, both leaning downwind
//   water       rain soaks and cools; moisture on hot cells boils off as steam
// `Texture` (R = temperature / 1200, G = char, B = wetness, A = burning) is ready to sample
// from a ground shader for scorch marks, ember glow and wet patches.
using UnityEngine;

public class LuminaThermoField : MonoBehaviour
{
    public const float Ambient = 22f, Ignition = 280f, Flame = 950f, Step = 1f / 20f;

    public float size = 40f;
    public int resolution = 96;
    [Tooltip("Wind velocity in m/s (set it from your weather system).")]
    public Vector3 wind = new Vector3(6f, 0f, 2f);
    [Range(0f, 1f)] public float rain = 0f;

    public Texture2D Texture { get; private set; }
    public int BurningCells { get; private set; }
    public int CharredCells { get; private set; }
    public float Intensity { get; private set; }
    public event System.Action<Vector3> Ignited;
    public event System.Action<Vector3, float> Steam;

    float[] t, t2, fuel, fuel0, wet, charred, burn;
    Color32[] pixels;
    float accumulator;
    bool active;

    void Awake()
    {
        int n = resolution * resolution;
        t = new float[n]; t2 = new float[n]; fuel = new float[n]; fuel0 = new float[n]; wet = new float[n]; charred = new float[n]; burn = new float[n];
        for (int i = 0; i < n; i++) t[i] = t2[i] = Ambient;
        pixels = new Color32[n];
        Texture = new Texture2D(resolution, resolution, TextureFormat.RGBA32, false, true) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
    }

    float Cell { get { return size / resolution; } }

    int Index(float x, float z)
    {
        float u = (x - transform.position.x) / size + 0.5f, v = (z - transform.position.z) / size + 0.5f;
        if (u < 0f || u >= 1f || v < 0f || v >= 1f) return -1;
        return (int)(v * resolution) * resolution + (int)(u * resolution);
    }

    Vector3 WorldOf(int i)
    {
        return new Vector3(((i % resolution) + 0.5f) / resolution * size - size * 0.5f + transform.position.x, transform.position.y,
            ((i / resolution) + 0.5f) / resolution * size - size * 0.5f + transform.position.z);
    }

    delegate void CellAction(int index, float falloff);

    void ForDisc(float x, float z, float radius, CellAction action)
    {
        float cu = (x - transform.position.x) / size * resolution + resolution * 0.5f;
        float cv = (z - transform.position.z) / size * resolution + resolution * 0.5f;
        int span = Mathf.CeilToInt(radius / Cell);
        for (int v = Mathf.Max(0, (int)cv - span); v <= Mathf.Min(resolution - 1, (int)cv + span); v++)
        {
            for (int u = Mathf.Max(0, (int)cu - span); u <= Mathf.Min(resolution - 1, (int)cu + span); u++)
            {
                float d = new Vector2(u + 0.5f - cu, v + 0.5f - cv).magnitude * Cell;
                if (d <= radius) action(v * resolution + u, 1f - d / Mathf.Max(radius, 0.001f));
            }
        }
    }

    /// <summary>Lay fuel in a disc (kg/m2): 0.5 dry grass, 2-4 timber decking, 1.5 a petrol film.</summary>
    public void AddFuel(float x, float z, float radius, float amount)
    {
        ForDisc(x, z, radius, (i, k) => { fuel[i] += amount; fuel0[i] = Mathf.Max(fuel0[i], fuel[i]); });
    }

    /// <summary>Raise a disc to flame temperature (a match, a flare, a spark).</summary>
    public void Ignite(float x, float z, float radius = 0.8f)
    {
        ForDisc(x, z, radius, (i, k) => { t[i] = Mathf.Max(t[i], Ignition + 420f * (0.4f + 0.6f * k)); wet[i] *= 0.3f; });
        active = true;
        Ignited?.Invoke(new Vector3(x, transform.position.y, z));
    }

    public void Heat(float x, float z, float radius, float degrees)
    {
        ForDisc(x, z, radius, (i, k) => { t[i] = Mathf.Min(1400f, t[i] + degrees * k); });
        active = true;
    }

    /// <summary>Throw water on a disc: soaks it and carries heat away (steam where it is hot).</summary>
    public void Quench(float x, float z, float radius, float amount = 1f)
    {
        ForDisc(x, z, radius, (i, k) => { wet[i] = Mathf.Min(1f, wet[i] + amount * (0.4f + 0.6f * k)); });
        active = true;
    }

    public float TemperatureAt(float x, float z) { int i = Index(x, z); return i < 0 ? Ambient : t[i]; }
    public bool IsBurning(float x, float z) { int i = Index(x, z); return i >= 0 && burn[i] > 0.02f; }
    public float WetnessAt(float x, float z) { int i = Index(x, z); return i < 0 ? 0f : wet[i]; }
    public float CharAt(float x, float z) { int i = Index(x, z); return i < 0 ? 0f : charred[i]; }

    void FixedUpdate()
    {
        if (!active && rain <= 0f) return;
        accumulator = Mathf.Min(accumulator + Time.fixedDeltaTime, Step * 3f);
        while (accumulator >= Step) { Simulate(); accumulator -= Step; }
    }

    void Simulate()
    {
        int r = resolution;
        float cell = Cell;
        float speed = new Vector2(wind.x, wind.z).magnitude;
        float wx = speed > 0.01f ? wind.x / speed : 0f, wz = speed > 0.01f ? wind.z / speed : 0f;
        float lean = Mathf.Min(1f, speed / 14f);
        bool anyHot = false;
        float area = 0f, steamTotal = 0f;
        Vector3 steamAt = Vector3.zero;
        BurningCells = 0;
        CharredCells = 0;
        for (int i = 0; i < r * r; i++)
        {
            float temp = t[i], rate = 0f;
            if (fuel[i] > 0f && temp > Ignition && wet[i] < 0.4f)
            {
                rate = 0.055f * (0.35f + 0.65f * Mathf.Min(1f, (temp - Ignition) / 320f)) * (1f - wet[i] / 0.4f) * (0.75f + 0.5f * lean);
                fuel[i] = Mathf.Max(0f, fuel[i] - rate * fuel0[i] * Step);
                temp += (Flame - temp) * Mathf.Min(1f, 2.6f * Step);
                charred[i] = Mathf.Max(charred[i], 1f - fuel[i] / Mathf.Max(fuel0[i], 0.0001f));
            }
            else if (fuel0[i] > 0f && temp > 180f) charred[i] = Mathf.Min(1f, charred[i] + (temp - 180f) * 0.0006f);
            burn[i] = Mathf.Min(1f, rate * 18f);
            if (rain > 0f) { wet[i] = Mathf.Min(1f, wet[i] + rain * 0.5f * Step); temp -= (temp - Ambient) * rain * 0.9f * Step; }
            if (wet[i] > 0f && temp > 100f)
            {
                // Finite boil-off: light rain only cools a fire, heavy rain or a hose drowns it.
                float boiled = Mathf.Min(wet[i], (temp - 100f) * 0.00044f * Step);
                wet[i] -= boiled;
                temp = Mathf.Max(60f, temp - boiled * 520f);
                if (boiled > 0.0015f) { steamTotal += boiled; steamAt = WorldOf(i); }
            }
            else if (wet[i] > 0f) wet[i] = Mathf.Max(0f, wet[i] - (0.006f + 0.0004f * Mathf.Max(0f, temp - Ambient)) * Step * (1f - rain));
            temp -= (temp - Ambient) * (0.16f + 0.1f * lean) * Step;
            t[i] = temp;
            if (rate > 0f) { BurningCells++; area += burn[i]; }
            if (charred[i] > 0.3f) CharredCells++;
            if (temp > Ambient + 2f || wet[i] > 0.01f) anyHot = true;
        }
        // Conduction + radiant pre-heating, both leaning downwind.
        float conduct = Mathf.Min(0.02f, 0.0009f * Step / (cell * cell) * 30f);
        for (int v = 0; v < r; v++)
        {
            for (int u = 0; u < r; u++)
            {
                int i = v * r + u;
                float acc = 0f, radiant = 0f;
                for (int dv = -1; dv <= 1; dv++)
                {
                    for (int du = -1; du <= 1; du++)
                    {
                        if (du == 0 && dv == 0) continue;
                        int uu = u + du, vv = v + dv;
                        if (uu < 0 || vv < 0 || uu >= r || vv >= r) continue;
                        int j = vv * r + uu;
                        float length = du != 0 && dv != 0 ? 1.4142f : 1f;
                        float along = (-du * wx - dv * wz) / length;
                        float bias = 1f + lean * 2.2f * Mathf.Max(0f, along) - lean * 0.75f * Mathf.Max(0f, -along);
                        acc += (t[j] - t[i]) * bias / length;
                        if (burn[j] > 0f) radiant += burn[j] * bias * bias / length;
                    }
                }
                float temp = t[i] + acc * conduct;
                if (radiant > 0f && fuel[i] > 0f && burn[i] == 0f) temp += radiant * (26f + 60f * lean) * Step * (1f - 0.85f * wet[i]);
                t2[i] = Mathf.Min(1400f, temp);
            }
        }
        float[] swap = t; t = t2; t2 = swap;
        Intensity = area * cell * cell;
        if (steamTotal > 0.01f) Steam?.Invoke(steamAt, Mathf.Min(1f, steamTotal * 2f + 0.2f));
        active = anyHot || BurningCells > 0;
        Publish();
    }

    void Publish()
    {
        for (int i = 0; i < pixels.Length; i++)
        {
            pixels[i] = new Color32((byte)(Mathf.Clamp01(t[i] / 1200f) * 255f), (byte)(charred[i] * 255f), (byte)(wet[i] * 255f), (byte)(burn[i] * 255f));
        }
        Texture.SetPixels32(pixels);
        Texture.Apply(false);
    }
}
