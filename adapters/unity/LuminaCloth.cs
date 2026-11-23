// lumina-physics · Verlet cloth for flags, banners, sails and canopies (spec 10).
//
// A port of the reference CPU solver (modules/cloth/cpu.ts): a grid of particles,
// position-based structural / shear / bend constraints, aerodynamic load along the surface
// normal, travelling-wave flutter, long-range tethers that stop the cloth stretching off
// its pins, sphere colliders and a ground plane. The component's transform is the piece's
// frame: pins and tether anchors follow it.
using System.Collections.Generic;
using UnityEngine;

[RequireComponent(typeof(MeshFilter), typeof(MeshRenderer))]
public class LuminaCloth : MonoBehaviour
{
    public enum Hang { Hoist, TopEdge, TopCorners, Free }

    public int cols = 28;
    public int rows = 18;
    public Vector2 size = new Vector2(2.4f, 1.5f);
    public Hang hang = Hang.Hoist;
    [Tooltip("Wind velocity in m/s. Set it from your weather system every frame.")]
    public Vector3 wind = new Vector3(8f, 0f, 2f);
    public LuminaPhysics.LuminaWorldBus worldFields;
    [Range(0f, 1f)] public float stiffness = 0.92f;
    [Range(0f, 1f)] public float bend = 0.12f;
    public float dragNormal = 6.5f;
    public float dragTangent = 0.35f;
    public float gravityScale = 0.55f;
    public float damping = 0.25f;
    [Range(0f, 2f)] public float flutter = 1f;
    [Tooltip("Ram-air inflation for parachutes (0 = off).")]
    public float inflate = 0f;
    public int substeps = 2;
    public int iterations = 5;
    public float groundY = -1e5f;
    [Tooltip("Sphere colliders as (x, y, z, radius) in world space.")]
    public List<Vector4> colliders = new List<Vector4>();

    struct Blast { public Vector3 origin; public float strength, radius, age, duration; }

    Vector3[] pos, prev, rest, tetherAnchor, vertices, normals;
    float[] invMass, tetherLength;
    readonly List<Blast> blasts = new List<Blast>();
    Mesh mesh;
    float time;

    void Start()
    {
        if (!worldFields) worldFields = GetComponentInParent<LuminaPhysics.LuminaWorldBus>();
        Rebuild();
    }

    /// <summary>Recreate the particle grid (call after changing cols / rows / size / hang).</summary>
    public void Rebuild()
    {
        int count = cols * rows;
        pos = new Vector3[count]; prev = new Vector3[count]; rest = new Vector3[count];
        tetherAnchor = new Vector3[count]; vertices = new Vector3[count]; normals = new Vector3[count];
        invMass = new float[count]; tetherLength = new float[count];
        float dx = size.x / (cols - 1), dy = size.y / (rows - 1);
        var uv = new Vector2[count];
        for (int iy = 0; iy < rows; iy++)
        {
            for (int ix = 0; ix < cols; ix++)
            {
                int i = iy * cols + ix;
                var local = new Vector3(ix * dx, -iy * dy, 0f);
                if (hang != Hang.Hoist) local.x -= size.x * 0.5f;
                rest[i] = local;
                bool pinned = false;
                tetherLength[i] = -1f;
                switch (hang)
                {
                    case Hang.Hoist:
                        pinned = ix == 0;
                        tetherAnchor[i] = new Vector3(0f, -iy * dy, 0f);
                        tetherLength[i] = ix * dx * 1.03f;
                        break;
                    case Hang.TopEdge:
                        pinned = iy == 0;
                        tetherAnchor[i] = new Vector3(local.x, 0f, 0f);
                        tetherLength[i] = iy * dy * 1.03f;
                        break;
                    case Hang.TopCorners:
                        pinned = iy == 0 && (ix == 0 || ix == cols - 1);
                        tetherAnchor[i] = new Vector3(local.x, 0f, 0f);
                        tetherLength[i] = iy * dy * 1.03f + size.x * 0.06f;
                        break;
                }
                if (pinned) tetherLength[i] = -1f;
                invMass[i] = pinned ? 0f : 1f;
                pos[i] = prev[i] = transform.TransformPoint(local);
                uv[i] = new Vector2(ix / (float)(cols - 1), 1f - iy / (float)(rows - 1));
            }
        }
        var triangles = new int[(cols - 1) * (rows - 1) * 6];
        int t = 0;
        for (int iy = 0; iy < rows - 1; iy++)
        {
            for (int ix = 0; ix < cols - 1; ix++)
            {
                int a = iy * cols + ix;
                triangles[t++] = a; triangles[t++] = a + 1; triangles[t++] = a + cols;
                triangles[t++] = a + 1; triangles[t++] = a + cols + 1; triangles[t++] = a + cols;
            }
        }
        mesh = new Mesh { name = "LuminaCloth" };
        mesh.MarkDynamic();
        mesh.vertices = vertices; mesh.uv = uv; mesh.triangles = triangles;
        GetComponent<MeshFilter>().sharedMesh = mesh;
    }

    /// <summary>A transient pressure front (explosion, sonic boom, rotor wash).</summary>
    public void AddBlast(Vector3 origin, float strength, float radius, float duration = 1.2f)
    {
        blasts.Add(new Blast { origin = origin, strength = strength, radius = radius, age = 0f, duration = duration });
    }

    /// <summary>World position of a grid point (gameplay queries, attaching objects).</summary>
    public Vector3 Point(int ix, int iy) { return pos[iy * cols + ix]; }

    Vector3 WindAt(Vector3 p)
    {
        Vector3 air = wind;
        if (worldFields) worldFields.Sample(p, out air, out _);
        for (int b = 0; b < blasts.Count; b++)
        {
            Blast blast = blasts[b];
            float k = blast.age / blast.duration;
            float radius = blast.radius * (0.35f + 0.65f * k);
            Vector3 delta = p - blast.origin;
            float dist = delta.magnitude + 0.001f;
            float fall = 1f - Mathf.Min(1f, dist / radius);
            air += delta / dist * (blast.strength * (1f - k) * (1f - k) * fall * fall);
        }
        return air;
    }

    void FixedUpdate()
    {
        if (pos == null) return;
        float dt = Time.fixedDeltaTime;
        time += dt;
        for (int b = blasts.Count - 1; b >= 0; b--)
        {
            Blast blast = blasts[b];
            blast.age += dt;
            if (blast.age >= blast.duration) blasts.RemoveAt(b); else blasts[b] = blast;
        }
        float h = Mathf.Min(dt, 1f / 30f) / substeps;
        for (int s = 0; s < substeps; s++)
        {
            Integrate(h);
            for (int k = 0; k < iterations; k++) Relax();
        }
        Upload();
    }

    void Integrate(float h)
    {
        float keep = Mathf.Max(0f, 1f - damping * h);
        Vector3 origin = transform.position;
        for (int iy = 0; iy < rows; iy++)
        {
            for (int ix = 0; ix < cols; ix++)
            {
                int i = iy * cols + ix;
                if (invMass[i] == 0f) { prev[i] = pos[i]; pos[i] = transform.TransformPoint(rest[i]); continue; }
                Vector3 p = pos[i];
                Vector3 n = Normal(ix, iy);
                Vector3 velocity = (p - prev[i]) / h;
                Vector3 air = WindAt(p);
                // Travelling-wave turbulence: steady wind sheds vortices that run down the cloth.
                float speed = new Vector2(air.x, air.z).magnitude;
                if (speed > 0.01f && flutter > 0f)
                {
                    float along = (p.x * air.x + p.z * air.z) / speed;
                    float wave = (Mathf.Sin(along * 3.1f - time * speed * 1.3f + p.y * 1.7f) * 0.34f
                        + Mathf.Sin(along * 7.3f - time * speed * 2.9f - p.y * 2.3f) * 0.2f) * speed * flutter;
                    air += new Vector3(-air.z / speed * wave, wave * 0.35f, air.x / speed * wave);
                }
                Vector3 rel = air - velocity;
                Vector3 force = rel * dragTangent;
                float n2 = n.sqrMagnitude;
                if (n2 > 1e-8f)
                {
                    force += n * (Vector3.Dot(n, rel) / n2 * dragNormal);
                    if (inflate > 0f && rel.y > 0f)
                    {
                        float side = Vector3.Dot(n, p - origin) >= 0f ? 1f : -1f;
                        force += n / Mathf.Sqrt(n2) * (side * rel.y * inflate);
                    }
                }
                force.y -= 9.81f * gravityScale;
                prev[i] = p;
                pos[i] = p + velocity * h * keep + force * h * h;
            }
        }
    }

    Vector3 Normal(int ix, int iy)
    {
        Vector3 left = pos[iy * cols + Mathf.Max(ix - 1, 0)], right = pos[iy * cols + Mathf.Min(ix + 1, cols - 1)];
        Vector3 up = pos[Mathf.Max(iy - 1, 0) * cols + ix], down = pos[Mathf.Min(iy + 1, rows - 1) * cols + ix];
        return Vector3.Cross(right - left, down - up);
    }

    void Solve(int i, int j, float restLength, float weight)
    {
        float wi = invMass[i], wj = invMass[j], sum = wi + wj;
        if (sum == 0f) return;
        Vector3 delta = pos[j] - pos[i];
        float length = delta.magnitude;
        if (length < 1e-9f) return;
        float k = (length - restLength) / length * weight / sum;
        pos[i] += delta * (k * wi);
        pos[j] -= delta * (k * wj);
    }

    void Relax()
    {
        float dx = size.x / (cols - 1), dy = size.y / (rows - 1);
        float diagonal = Mathf.Sqrt(dx * dx + dy * dy);
        for (int iy = 0; iy < rows; iy++)
        {
            for (int ix = 0; ix < cols; ix++)
            {
                int i = iy * cols + ix;
                if (ix + 1 < cols) Solve(i, i + 1, dx, stiffness);
                if (iy + 1 < rows) Solve(i, i + cols, dy, stiffness);
                if (ix + 1 < cols && iy + 1 < rows)
                {
                    Solve(i, i + cols + 1, diagonal, stiffness * 0.6f);
                    Solve(i + 1, i + cols, diagonal, stiffness * 0.6f);
                }
                if (bend > 0f)
                {
                    if (ix + 2 < cols) Solve(i, i + 2, dx * 2f, stiffness * bend);
                    if (iy + 2 < rows) Solve(i, i + cols * 2, dy * 2f, stiffness * bend);
                }
            }
        }
        for (int i = 0; i < pos.Length; i++)
        {
            if (invMass[i] == 0f) continue;
            Vector3 p = pos[i];
            if (tetherLength[i] >= 0f)
            {
                Vector3 anchor = transform.TransformPoint(tetherAnchor[i]);
                Vector3 d = p - anchor;
                float length = d.magnitude;
                if (length > tetherLength[i]) p = anchor + d * (tetherLength[i] / length);
            }
            for (int c = 0; c < colliders.Count; c++)
            {
                Vector3 centre = colliders[c];
                Vector3 d = p - centre;
                float length = d.magnitude;
                if (length < colliders[c].w && length > 1e-6f) p = centre + d * (colliders[c].w / length);
            }
            p.y = Mathf.Max(p.y, groundY);
            pos[i] = p;
        }
    }

    void Upload()
    {
        for (int iy = 0; iy < rows; iy++)
        {
            for (int ix = 0; ix < cols; ix++)
            {
                int i = iy * cols + ix;
                vertices[i] = transform.InverseTransformPoint(pos[i]);
                normals[i] = transform.InverseTransformDirection(Normal(ix, iy)).normalized;
            }
        }
        mesh.vertices = vertices;
        mesh.normals = normals;
        mesh.RecalculateBounds();
    }
}
