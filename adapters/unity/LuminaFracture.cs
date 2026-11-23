// lumina-physics · Pre-fractured destructible box: concrete, glass, wood or brick (spec 11).
//
// Port of modules/destruction: the box is cut into convex Voronoi cells (each cell is the box
// intersected with the bisector half-spaces of its site), so every chunk is a valid convex
// collider and knows its neighbours. Impact() loosens the chunks near a hit into Rigidbody
// pieces with mass = volume x density; a flood fill from the anchored chunks then drops
// whatever is no longer held up.
using System.Collections.Generic;
using UnityEngine;

public class LuminaFracture : MonoBehaviour
{
    public enum Kind { Concrete, Glass, Wood, Brick }

    public Kind kind = Kind.Concrete;
    public Vector3 size = new Vector3(4f, 2.4f, 0.35f);
    public int pieces = 28;
    public int seed = 11;
    public float toughness = 1f;
    public Material material;

    public int Broken { get; private set; }
    public event System.Action<int, Vector3> Broke;

    static readonly float[] Density = { 2400f, 2500f, 620f, 1900f };
    /// <summary>Joules per cubic metre of material turned into loose chunks.</summary>
    static readonly float[] FractureEnergy = { 240000f, 2500f, 60000f, 110000f };

    public class Face { public List<Vector3> points = new List<Vector3>(); public Vector3 normal; public int owner = -1; }

    public class Cell
    {
        public List<Face> faces = new List<Face>();
        public Vector3 centroid;
        public float volume;
        public int site;
        public List<int> neighbours = new List<int>();
        public bool loose, anchored;
        public GameObject node;
        public MeshCollider collider;
    }

    public readonly List<Cell> cells = new List<Cell>();
    BoxCollider intact;

    void Start()
    {
        intact = gameObject.AddComponent<BoxCollider>();
        intact.size = size;
        Fracture(Vector3.zero);
    }

    // ---- convex geometry ----------------------------------------------------------

    static List<Face> BoxFaces(Vector3 extent)
    {
        Vector3 h = extent * 0.5f;
        var faces = new List<Face>();
        void Quad(Vector3 n, Vector3 a, Vector3 b, Vector3 c, Vector3 d)
        {
            var f = new Face { normal = n };
            f.points.AddRange(new[] { a, b, c, d });
            faces.Add(f);
        }
        Quad(Vector3.right, new Vector3(h.x, -h.y, -h.z), new Vector3(h.x, h.y, -h.z), new Vector3(h.x, h.y, h.z), new Vector3(h.x, -h.y, h.z));
        Quad(Vector3.left, new Vector3(-h.x, -h.y, h.z), new Vector3(-h.x, h.y, h.z), new Vector3(-h.x, h.y, -h.z), new Vector3(-h.x, -h.y, -h.z));
        Quad(Vector3.up, new Vector3(-h.x, h.y, -h.z), new Vector3(-h.x, h.y, h.z), new Vector3(h.x, h.y, h.z), new Vector3(h.x, h.y, -h.z));
        Quad(Vector3.down, new Vector3(-h.x, -h.y, h.z), new Vector3(-h.x, -h.y, -h.z), new Vector3(h.x, -h.y, -h.z), new Vector3(h.x, -h.y, h.z));
        Quad(Vector3.forward, new Vector3(-h.x, -h.y, h.z), new Vector3(h.x, -h.y, h.z), new Vector3(h.x, h.y, h.z), new Vector3(-h.x, h.y, h.z));
        Quad(Vector3.back, new Vector3(h.x, -h.y, -h.z), new Vector3(-h.x, -h.y, -h.z), new Vector3(-h.x, h.y, -h.z), new Vector3(h.x, h.y, -h.z));
        return faces;
    }

    /// <summary>Keep the part of a convex solid on the negative side of n.x = d; close the cut with a face owned by tag.</summary>
    static List<Face> Clip(List<Face> solid, Vector3 n, float d, int tag)
    {
        var result = new List<Face>();
        var rim = new List<Vector3>();
        foreach (Face face in solid)
        {
            var kept = new Face { normal = face.normal, owner = face.owner };
            int count = face.points.Count;
            for (int i = 0; i < count; i++)
            {
                Vector3 a = face.points[i], b = face.points[(i + 1) % count];
                float da = Vector3.Dot(n, a) - d, db = Vector3.Dot(n, b) - d;
                if (da <= 1e-7f) kept.points.Add(a);
                if ((da < -1e-7f && db > 1e-7f) || (da > 1e-7f && db < -1e-7f))
                {
                    Vector3 p = Vector3.Lerp(a, b, da / (da - db));
                    kept.points.Add(p);
                    rim.Add(p);
                }
            }
            if (kept.points.Count >= 3) result.Add(kept);
        }
        if (rim.Count >= 3)
        {
            // The cut of a convex solid is a convex polygon: order its points by angle.
            Vector3 centre = Vector3.zero;
            foreach (Vector3 p in rim) centre += p;
            centre /= rim.Count;
            Vector3 u = Vector3.Cross(n, Mathf.Abs(n.x) < 0.9f ? Vector3.right : Vector3.up).normalized;
            Vector3 w = Vector3.Cross(n, u);
            rim.Sort((a, b) => Mathf.Atan2(Vector3.Dot(a - centre, w), Vector3.Dot(a - centre, u)).CompareTo(Mathf.Atan2(Vector3.Dot(b - centre, w), Vector3.Dot(b - centre, u))));
            var cap = new Face { normal = n, owner = tag };
            foreach (Vector3 p in rim) if (cap.points.Count == 0 || (cap.points[cap.points.Count - 1] - p).sqrMagnitude > 1e-10f) cap.points.Add(p);
            if (cap.points.Count >= 3) result.Add(cap);
        }
        return result;
    }

    static void Measure(Cell cell)
    {
        Vector3 reference = Vector3.zero;
        int count = 0;
        foreach (Face f in cell.faces) foreach (Vector3 p in f.points) { reference += p; count++; }
        reference /= Mathf.Max(count, 1);
        Vector3 centroid = Vector3.zero;
        float volume = 0f;
        foreach (Face f in cell.faces)
        {
            for (int i = 1; i + 1 < f.points.Count; i++)
            {
                Vector3 a = f.points[0] - reference, b = f.points[i] - reference, c = f.points[i + 1] - reference;
                float v = Mathf.Abs(Vector3.Dot(a, Vector3.Cross(b, c))) / 6f;
                volume += v;
                centroid += (f.points[0] + f.points[i] + f.points[i + 1] + reference) * (v / 4f);
            }
        }
        cell.volume = volume;
        cell.centroid = volume > 1e-12f ? centroid / volume : reference;
    }

    /// <summary>Voronoi cells inside the box. Material character comes from where the sites go.</summary>
    public void Fracture(Vector3 focus)
    {
        foreach (Cell old in cells) if (old.node != null) Destroy(old.node);
        cells.Clear();
        Broken = 0;
        var random = new System.Random(seed);
        float Rand(float lo, float hi) { return lo + (float)random.NextDouble() * (hi - lo); }
        Vector3 half = size * 0.5f;
        Vector3 stretch = Vector3.one;
        var sites = new List<Vector3>();
        if (kind == Kind.Glass)
        {
            // Rings and spokes in the pane, through its full thickness: radial shards.
            int thin = size.x <= size.y && size.x <= size.z ? 0 : (size.y <= size.z ? 1 : 2);
            int u = (thin + 1) % 3, w = (thin + 2) % 3;
            float radius = new Vector2(size[u], size[w]).magnitude * 0.045f;
            Vector3 centre = focus;
            centre[thin] = 0f;
            sites.Add(centre);
            int rings = Mathf.Max(2, Mathf.RoundToInt(Mathf.Sqrt(pieces / 5f)));
            for (int r = 0; r < rings; r++)
            {
                int spokes = Mathf.RoundToInt(5f + r * (pieces / (float)rings / 2.2f));
                float phase = Rand(0f, Mathf.PI * 2f);
                for (int s = 0; s < spokes; s++)
                {
                    float angle = phase + (s + Rand(-0.275f, 0.275f)) / spokes * Mathf.PI * 2f;
                    Vector3 p = centre;
                    p[u] += Mathf.Cos(angle) * radius * Rand(0.8f, 1.25f);
                    p[w] += Mathf.Sin(angle) * radius * Rand(0.8f, 1.25f);
                    sites.Add(p);
                }
                radius *= 2.1f;
            }
        }
        else if (kind == Kind.Wood)
        {
            // Fracture in a space squashed along the grain: cells come out as long splinters.
            int grain = size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2);
            stretch[grain] = 0.16f;
            for (int i = 0; i < pieces; i++) sites.Add(new Vector3(Rand(-half.x, half.x), Rand(-half.y, half.y), Rand(-half.z, half.z)));
        }
        else
        {
            float spread = Mathf.Max(size.x, Mathf.Max(size.y, size.z)) * 0.22f;
            for (int i = 0; i < pieces; i++)
            {
                if (i % 2 == 0)
                {
                    Vector3 p = focus + new Vector3(Rand(-spread, spread), Rand(-spread, spread), Rand(-spread, spread));
                    sites.Add(Vector3.Max(-half, Vector3.Min(half, p)));
                }
                else sites.Add(new Vector3(Rand(-half.x, half.x), Rand(-half.y, half.y), Rand(-half.z, half.z)));
            }
        }

        List<Face> box = BoxFaces(Vector3.Scale(size, stretch));
        var indexOf = new Dictionary<int, int>();
        for (int i = 0; i < sites.Count; i++)
        {
            Vector3 site = Vector3.Scale(sites[i], stretch);
            var solid = new List<Face>();
            foreach (Face f in box) { var copy = new Face { normal = f.normal, owner = -1 }; copy.points.AddRange(f.points); solid.Add(copy); }
            for (int j = 0; j < sites.Count && solid.Count >= 4; j++)
            {
                if (j == i) continue;
                Vector3 other = Vector3.Scale(sites[j], stretch);
                float dist = Vector3.Distance(site, other);
                if (dist < 1e-6f) continue;
                Vector3 n = (other - site) / dist;
                solid = Clip(solid, n, Vector3.Dot(n, site) + dist * 0.5f, j);
            }
            if (solid.Count < 4) continue;
            var cell = new Cell { site = i };
            foreach (Face f in solid)
            {
                // Undo the stretch.
                for (int k = 0; k < f.points.Count; k++) f.points[k] = new Vector3(f.points[k].x / stretch.x, f.points[k].y / stretch.y, f.points[k].z / stretch.z);
                f.normal = Vector3.Scale(f.normal, stretch).normalized;
                cell.faces.Add(f);
            }
            Measure(cell);
            if (cell.volume < 1e-9f) continue;
            foreach (Face f in cell.faces)
            {
                foreach (Vector3 p in f.points)
                {
                    if (kind == Kind.Glass) cell.anchored |= Mathf.Abs(Mathf.Abs(p.x) - half.x) < 0.004f || Mathf.Abs(Mathf.Abs(p.y) - half.y) < 0.004f;
                    else if (p.y < -half.y + 0.012f) cell.anchored = true;
                }
            }
            indexOf[i] = cells.Count;
            cells.Add(cell);
        }
        foreach (Cell cell in cells)
        {
            foreach (Face f in cell.faces)
            {
                if (f.owner >= 0 && indexOf.TryGetValue(f.owner, out int other) && !cell.neighbours.Contains(other)) cell.neighbours.Add(other);
            }
            cell.node = MakeVisual(cell);
        }
    }

    Mesh ChunkMesh(Cell cell)
    {
        var vertices = new List<Vector3>();
        var normals = new List<Vector3>();
        var triangles = new List<int>();
        foreach (Face f in cell.faces)
        {
            Vector3 n = Vector3.Dot(f.normal, f.points[0] - cell.centroid) < 0f ? -f.normal : f.normal;
            for (int i = 1; i + 1 < f.points.Count; i++)
            {
                Vector3 a = f.points[0], b = f.points[i], c = f.points[i + 1];
                // Unity front faces wind clockwise.
                if (Vector3.Dot(Vector3.Cross(b - a, c - a), n) > 0f) { Vector3 swap = b; b = c; c = swap; }
                foreach (Vector3 p in new[] { a, b, c }) { triangles.Add(vertices.Count); vertices.Add(p - cell.centroid); normals.Add(n); }
            }
        }
        var mesh = new Mesh();
        mesh.SetVertices(vertices);
        mesh.SetNormals(normals);
        mesh.SetTriangles(triangles, 0);
        mesh.RecalculateBounds();
        return mesh;
    }

    GameObject MakeVisual(Cell cell)
    {
        var node = new GameObject("chunk");
        node.transform.SetParent(transform, false);
        node.transform.localPosition = cell.centroid;
        node.AddComponent<MeshFilter>().sharedMesh = ChunkMesh(cell);
        node.AddComponent<MeshRenderer>().sharedMaterial = material;
        return node;
    }

    // ---- damage ------------------------------------------------------------------

    /// <summary>Hit the object at a world point with `energy` joules along `direction`.</summary>
    public int Impact(Vector3 point, Vector3 direction, float energy)
    {
        Vector3 local = transform.InverseTransformPoint(point);
        Vector3 half = size * 0.5f;
        if (kind == Kind.Glass && Broken == 0)
        {
            if (energy < 60f * toughness) return 0;
            Fracture(Vector3.Max(-half, Vector3.Min(half, local)));
        }
        float volume = energy / (FractureEnergy[(int)kind] * toughness);
        float radius = Mathf.Pow(volume * 3f / (4f * Mathf.PI), 1f / 3f);
        if (kind == Kind.Glass) radius = Mathf.Max(radius * 6f, energy > 400f * toughness ? 10f : 0.35f);
        var picked = new List<int>();
        float mass = 0f;
        for (int i = 0; i < cells.Count; i++)
        {
            if (!cells[i].loose && Vector3.Distance(cells[i].centroid, local) < radius) { picked.Add(i); mass += cells[i].volume * Density[(int)kind]; }
        }
        if (picked.Count == 0) return 0;
        float speed = Mathf.Min(14f, Mathf.Sqrt(2f * energy * 0.25f / Mathf.Max(1f, mass)));
        foreach (int i in picked)
        {
            Vector3 outward = transform.TransformDirection(cells[i].centroid - local).normalized;
            Loosen(i, outward * speed * 0.35f + direction.normalized * speed);
        }
        int total = picked.Count + Collapse();
        Broke?.Invoke(total, point);
        return total;
    }

    /// <summary>Pressure wave: loosens what it can overcome (call from your explosion code).</summary>
    public int Blast(Vector3 centre, float radius, float strength)
    {
        Vector3 local = transform.InverseTransformPoint(centre);
        Vector3 half = size * 0.5f;
        if (kind == Kind.Glass && Broken == 0) Fracture(Vector3.Max(-half, Vector3.Min(half, local)));
        float reach = radius * (kind == Kind.Glass ? 1.4f : (kind == Kind.Concrete ? 0.42f : 0.6f));
        int picked = 0;
        for (int i = 0; i < cells.Count; i++)
        {
            if (cells[i].loose) continue;
            float fall = Mathf.Max(0f, 1f - Vector3.Distance(cells[i].centroid, local) / reach);
            if (fall * fall * strength / toughness > (kind == Kind.Glass ? 0.02f : 0.4f))
            {
                Loosen(i, transform.TransformDirection(cells[i].centroid - local).normalized * 6f * fall);
                picked++;
            }
        }
        if (picked > 0) { picked += Collapse(); Broke?.Invoke(picked, centre); }
        return picked;
    }

    void Loosen(int index, Vector3 velocity)
    {
        Cell cell = cells[index];
        if (cell.loose) return;
        EnsureChunkColliders();
        cell.loose = true;
        Broken++;
        cell.node.transform.SetParent(null, true);
        if (cell.collider == null) { cell.collider = cell.node.AddComponent<MeshCollider>(); cell.collider.sharedMesh = cell.node.GetComponent<MeshFilter>().sharedMesh; }
        cell.collider.convex = true;
        var body = cell.node.AddComponent<Rigidbody>();
        body.mass = Mathf.Max(0.01f, cell.volume * Density[(int)kind]);
        body.velocity = velocity;
        body.angularVelocity = Random.insideUnitSphere * 5f;
    }

    /// <summary>After the first damage the single box collider is replaced by one hull per chunk.</summary>
    void EnsureChunkColliders()
    {
        if (intact == null) return;
        Destroy(intact);
        intact = null;
        foreach (Cell cell in cells)
        {
            if (cell.loose || cell.collider != null) continue;
            cell.collider = cell.node.AddComponent<MeshCollider>();
            cell.collider.sharedMesh = cell.node.GetComponent<MeshFilter>().sharedMesh;
            cell.collider.convex = true;
        }
    }

    /// <summary>Drop every intact chunk that is no longer connected to an anchored one.</summary>
    int Collapse()
    {
        var supported = new HashSet<int>();
        var queue = new Stack<int>();
        for (int i = 0; i < cells.Count; i++) if (!cells[i].loose && cells[i].anchored) { supported.Add(i); queue.Push(i); }
        while (queue.Count > 0)
        {
            int i = queue.Pop();
            foreach (int j in cells[i].neighbours) if (!cells[j].loose && supported.Add(j)) queue.Push(j);
        }
        int fallen = 0;
        for (int i = 0; i < cells.Count; i++) if (!cells[i].loose && !supported.Contains(i)) { Loosen(i, Vector3.zero); fallen++; }
        return fallen;
    }
}
