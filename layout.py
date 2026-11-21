#!/usr/bin/env python3
"""Gera layout real do grafo e regrava x/y, degree e community em nodes.bin.

1a execucao: Louvain -> salva comm_levels.npy e sai.
2a execucao: empacota as comunidades (BFS + sunflower por area), posiciona os
nos e regrava nodes.bin (backup em nodes.orig.bin) + layout_preview.png.
"""
import gc
import os
import time

import numpy as np

DIR = "frontend" if os.path.exists("frontend/nodes.bin") else "."
NODES = os.path.join(DIR, "nodes.bin")
EDGES = os.path.join(DIR, "edges.bin")
LEVELS = os.path.join(DIR, "comm_levels.npy")
PREVIEW = os.path.join(DIR, "layout_preview.png")

NODE_DT = np.dtype([
    ("id", "<u4"), ("x", "<f4"), ("y", "<f4"),
    ("deg", "<u4"), ("comm", "<u4"), ("off", "<u4"), ("len", "<u2"),
])


SEP = 2.2          # separacao entre comunidades (original 1.3)
POW = 0.85         # expoente radial intra-comunidade (original 0.65)
K = 1.5            # escala intra-comunidade (original 1.8)
ITERS = 40         # iteracoes do refino (original 20)
REP = 1.0          # repulsao entre nos (original 0.5): maior = nos mais esparsos
GRAV_FINE = 0.10   # gravidade ao centroide da comunidade (nivel fino do Louvain)
GRAV_COARSE = 0.03 # gravidade ao centroide da super-comunidade (nivel grosso)


def load_edges():
    n = np.fromfile(NODES, dtype=NODE_DT)
    e = np.fromfile(EDGES, dtype=np.dtype([("s", "<u4"), ("t", "<u4")]))
    lo, hi = int(n["id"][0]), int(n["id"][-1])
    lk = np.full(hi - lo + 1, -1, np.int32)
    lk[n["id"] - lo] = np.arange(n.size, dtype=np.int32)
    src = lk[e["s"] - lo]
    dst = lk[e["t"] - lo]
    return n, src, dst


def louvain(src, dst, n):
    import igraph as ig
    arr = np.empty((src.size, 2), np.int32)
    arr[:, 0] = src
    arr[:, 1] = dst
    g = ig.Graph(n=n, edges=arr)
    del arr
    t = time.time()
    levels = g.community_multilevel(return_levels=True)
    print("louvain %.1fs niveis %s" % (time.time() - t, [len(l) for l in levels]))
    out = np.empty((len(levels), n), np.int32)
    for i, l in enumerate(levels):
        out[i] = np.asarray(l.membership, np.int32)
    np.save(LEVELS, out)
    del g, levels
    gc.collect()


def bfs_order(size, a, b, C):
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import breadth_first_order, connected_components
    A = coo_matrix((np.ones(a.size, np.int8), (a, b)), shape=(C, C)).tocsr()
    nc, lab = connected_components(A, directed=False)
    comps = {}
    for i, c in enumerate(lab):
        comps.setdefault(c, []).append(i)
    ranked = sorted(comps.values(), key=lambda v: -size[v].sum())
    order = []
    for nodes in ranked:
        nodes = np.array(nodes)
        order.extend(breadth_first_order(
            A, nodes[np.argmax(size[nodes])], directed=False)[0])
    return np.array(order)


def force_layout(pos, src, dst, iters, G, max_step, anchor=None, anchor_k=0.0, groups=(), rep=0.5):
    """FR aproximado: molas + repulsao por grid (+ ancora no centro da comunidade)."""
    N = pos.shape[0]
    M = 5_000_000
    step = max(1, src.size // M)
    es, et = src[::step], dst[::step]
    groups = [(g, np.maximum(np.bincount(g), 1), k) for g, k in groups]

    for it in range(iters):
        speed = 0.2 * (1.0 - it / iters) + 0.01

        f = (pos[et] - pos[es]) * 0.05
        fa = np.empty_like(pos)
        fa[:, 0] = np.bincount(es, f[:, 0], N) + np.bincount(et, -f[:, 0], N)
        fa[:, 1] = np.bincount(es, f[:, 1], N) + np.bincount(et, -f[:, 1], N)

        lo, hi = pos.min(0), pos.max(0)
        span = np.maximum(hi - lo, 1e-6)
        cx = np.clip(((pos[:, 0] - lo[0]) / span[0] * G).astype(np.int32), 0, G - 1)
        cy = np.clip(((pos[:, 1] - lo[1]) / span[1] * G).astype(np.int32), 0, G - 1)
        cell = cy * G + cx
        cnt = np.bincount(cell, minlength=G * G).astype(np.float32).reshape(G, G)
        sx = np.bincount(cell, pos[:, 0], G * G).astype(np.float32).reshape(G, G)
        sy = np.bincount(cell, pos[:, 1], G * G).astype(np.float32).reshape(G, G)

        fx = np.zeros(N, np.float32)
        fy = np.zeros(N, np.float32)
        for oy in (-2, -1, 0, 1, 2):
            for ox in (-2, -1, 0, 1, 2):
                c = np.roll(cnt, (oy, ox), (0, 1))
                mx = np.roll(sx, (oy, ox), (0, 1)) / np.maximum(c, 1)
                my = np.roll(sy, (oy, ox), (0, 1)) / np.maximum(c, 1)
                dx = pos[:, 0] - mx[cy, cx]
                dy = pos[:, 1] - my[cy, cx]
                w = rep * c[cy, cx] / (dx * dx + dy * dy + 1e-4)
                fx += dx * w
                fy += dy * w

        for g, cg, k in groups:  # gravidade dinamica ao centroide de cada grupo
            gx = np.bincount(g, pos[:, 0]) / cg
            gy = np.bincount(g, pos[:, 1]) / cg
            fx += (gx[g] - pos[:, 0]) * k
            fy += (gy[g] - pos[:, 1]) * k

        if anchor is not None:
            fx += (anchor[:, 0] - pos[:, 0]) * anchor_k
            fy += (anchor[:, 1] - pos[:, 1]) * anchor_k

        v = (fa + np.column_stack((fx, fy))) * speed
        norm = np.sqrt((v * v).sum(1)) + 1e-6
        v *= np.minimum(1.0, max_step / norm)[:, None]
        pos += v

        if it % 10 == 0:
            print("  iter %d/%d bbox %.1f x %.1f" % (
                it, iters, np.ptp(pos[:, 0]), np.ptp(pos[:, 1])))


def preview(pos, comm, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    idx = np.random.default_rng(0).choice(pos.shape[0], 200_000, replace=False)
    plt.figure(figsize=(12, 12), facecolor="#0b0e14")
    plt.scatter(pos[idx, 0], pos[idx, 1], s=0.25, c=comm[idx] % 12,
                cmap="hsv", linewidths=0, alpha=0.6)
    plt.axis("off")
    plt.tight_layout()
    plt.savefig(path, dpi=100, facecolor="#0b0e14")
    plt.close()


def main():
    n, src, dst = load_edges()
    print("N=%d E=%d" % (n.size, src.size))

    if not os.path.exists(LEVELS):
        louvain(src, dst, n.size)
        print("comm_levels.npy salvo. Rode de novo para gerar o layout.")
        return

    levels = np.load(LEVELS)
    comm = levels[0]
    C = int(comm.max()) + 1
    size = np.bincount(comm).astype(np.float64)
    print("comunidades:", C, "maior:", int(size.max()))

    u = comm[src].astype(np.int32)
    v = comm[dst].astype(np.int32)
    m = u != v
    a, b = u[m], v[m]
    del u, v, m

    t = time.time()
    order = bfs_order(size, a, b, C)
    print("bfs %.1fs" % (time.time() - t))

    R = 100.0
    r = R * np.sqrt(size / n.size)
    s = size[order]
    cum = np.concatenate([[0.0], np.cumsum(s)])
    rho = R * np.sqrt((cum[:-1] + s / 2) / n.size)
    th = np.arange(C) * 2.399963229728653
    meta = np.zeros((C, 2), np.float32)
    meta[order, 0] = rho * np.cos(th)
    meta[order, 1] = rho * np.sin(th)

    rng = np.random.default_rng(2)
    ang = rng.uniform(0, 2 * np.pi, n.size).astype(np.float32)
    rad = r[comm] * np.sqrt(rng.uniform(0, 1, n.size)).astype(np.float32)
    pos = meta[comm].copy()
    pos[:, 0] += np.cos(ang) * rad
    pos[:, 1] += np.sin(ang) * rad

    deg = np.bincount(src, minlength=n.size) + np.bincount(dst, minlength=n.size)
    t = time.time()
    force_layout(pos, src, dst, ITERS, G=512, max_step=0.3,
                 anchor=meta[comm], anchor_k=0.05, rep=REP,
                 groups=[(comm, GRAV_FINE), (levels[-1], GRAV_COARSE)])
    print("refino %.1fs" % (time.time() - t))

    # Expande e dispersa os nós para um layout mais esparso e legível
    c_count = np.bincount(comm)
    cx = np.bincount(comm, weights=pos[:, 0]) / np.maximum(c_count, 1)
    cy = np.bincount(comm, weights=pos[:, 1]) / np.maximum(c_count, 1)
    dx = pos[:, 0] - cx[comm]
    dy = pos[:, 1] - cy[comm]
    d = np.sqrt(dx * dx + dy * dy)
    m = d > 1e-6
    factor = np.zeros_like(d)
    factor[m] = np.power(d[m], POW) * K / d[m]

    new_x = cx[comm] * SEP + dx * factor
    new_y = cy[comm] * SEP + dy * factor
    span = max(new_x.max() - new_x.min(), new_y.max() - new_y.min())
    mid_x = (new_x.max() + new_x.min()) / 2
    mid_y = (new_y.max() + new_y.min()) / 2
    pos[:, 0] = (new_x - mid_x) / (span / 2)
    pos[:, 1] = (new_y - mid_y) / (span / 2)

    preview(pos, comm, PREVIEW)
    print("preview:", PREVIEW)

    out = n.copy()
    out["x"] = pos[:, 0]
    out["y"] = pos[:, 1]
    out["deg"] = deg.astype(np.uint32)
    out["comm"] = comm
    if not os.path.exists(os.path.join(DIR, "nodes.orig.bin")):
        n.tofile(os.path.join(DIR, "nodes.orig.bin"))
    out.tofile(NODES)
    print("nodes.bin atualizado")


if __name__ == "__main__":
    main()