// lumina-physics · Verlet rope / cable / power line between two transforms (spec 10).
//
// The cloth solver with a single row: distance + bend constraints, cross-flow wind drag on
// a cylinder, gravity sag set by `slack`. Drawn with a LineRenderer.
using UnityEngine;

[RequireComponent(typeof(LineRenderer))]
public class LuminaRope : MonoBehaviour
{
    public Transform from;
    public Transform to;
    public int segments = 20;
    [Tooltip("Rope length divided by the straight-line distance (1.02 taut cable, 1.3 slack line).")]
    public float slack = 1.04f;
    public Vector3 wind = new Vector3(8f, 0f, 2f);
    public float drag = 1.1f;
    public float damping = 0.45f;
    [Range(0f, 1f)] public float bend = 0.35f;
    public bool freeEnd = false;
    public int iterations = 6;
    public float groundY = -1e5f;

    Vector3[] pos, prev;
    float segment = 1f;
    LineRenderer line;

    void Start()
    {
        line = GetComponent<LineRenderer>();
        line.useWorldSpace = true;
        Rebuild();
    }

    public void Rebuild()
    {
        int count = segments + 1;
        float span = Vector3.Distance(from.position, to.position);
        segment = span * slack / segments;
        // Parabola with the arc length of the slack rope (first-order catenary).
        float sag = span * Mathf.Sqrt(Mathf.Max(0f, 3f * (slack - 1f) / 8f));
        pos = new Vector3[count]; prev = new Vector3[count];
        for (int i = 0; i < count; i++)
        {
            float t = i / (float)segments;
            Vector3 p = Vector3.Lerp(from.position, to.position, t);
            p.y -= sag * 4f * t * (1f - t);
            pos[i] = prev[i] = p;
        }
        line.positionCount = count;
    }

    bool Pinned(int i) { return i == 0 || (i == pos.Length - 1 && !freeEnd); }

    void FixedUpdate()
    {
        if (pos == null) return;
        float h = Mathf.Min(Time.fixedDeltaTime, 1f / 30f);
        int count = pos.Length;
        float keep = Mathf.Max(0f, 1f - damping * h);
        for (int i = 0; i < count; i++)
        {
            if (Pinned(i)) continue;
            Vector3 p = pos[i];
            Vector3 tangent = pos[Mathf.Min(i + 1, count - 1)] - pos[Mathf.Max(i - 1, 0)];
            Vector3 velocity = (p - prev[i]) / h;
            Vector3 rel = wind - velocity;
            // Only the cross-flow component loads a cable.
            Vector3 crossFlow = rel - tangent * (Vector3.Dot(tangent, rel) / Mathf.Max(tangent.sqrMagnitude, 1e-8f));
            Vector3 force = crossFlow * drag + new Vector3(0f, -9.81f, 0f);
            prev[i] = p;
            pos[i] = p + velocity * h * keep + force * h * h;
        }
        pos[0] = from.position;
        if (!freeEnd) pos[count - 1] = to.position;
        for (int k = 0; k < iterations; k++)
        {
            for (int i = 0; i < count - 1; i++) Solve(i, i + 1, segment, 0.95f);
            if (bend > 0f) for (int i = 0; i < count - 2; i++) Solve(i, i + 2, segment * 2f, 0.95f * bend);
            for (int i = 0; i < count; i++) pos[i].y = Mathf.Max(pos[i].y, groundY);
        }
        line.SetPositions(pos);
    }

    void Solve(int i, int j, float restLength, float weight)
    {
        float wi = Pinned(i) ? 0f : 1f, wj = Pinned(j) ? 0f : 1f;
        if (wi + wj == 0f) return;
        Vector3 delta = pos[j] - pos[i];
        float length = delta.magnitude;
        if (length < 1e-9f) return;
        float k = (length - restLength) / length * weight / (wi + wj);
        pos[i] += delta * (k * wi);
        pos[j] -= delta * (k * wj);
    }

    /// <summary>World position along the rope, t in 0..1.</summary>
    public Vector3 PointAt(float t)
    {
        float f = Mathf.Clamp01(t) * (pos.Length - 1);
        int i = Mathf.Min((int)f, pos.Length - 2);
        return Vector3.Lerp(pos[i], pos[i + 1], f - i);
    }
}
