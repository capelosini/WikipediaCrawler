#!/usr/bin/env python3
"""Gera layout topológico livre (multinível PPMI espectral + Cauchy t-SNE / FFT com balanço virial)
e regrava x/y, degree e community em nodes.bin.

1a execucao: Louvain -> salva comm_levels.npy e sai.
2a execucao: layout multinível sem restrição circular -> regrava nodes.bin
(backup em nodes.orig.bin) + layout_preview.png.
"""
import colorsys
import gc
import os
import time

import numpy as np
from scipy.sparse import coo_matrix, diags
from scipy.sparse.csgraph import connected_components
from scipy.sparse.linalg import eigsh

DIR = "frontend" if os.path.exists("frontend/nodes.bin") else "."
NODES = os.path.join(DIR, "nodes.bin")
EDGES = os.path.join(DIR, "edges.bin")
LEVELS = os.path.join(DIR, "comm_levels.npy")
PREVIEW = os.path.join(DIR, "layout_preview.png")

NODE_DT = np.dtype([
    ("id", "<u4"), ("x", "<f4"), ("y", "<f4"),
    ("deg", "<u4"), ("comm", "<u4"), ("off", "<u4"), ("len", "<u2"),
])


def load_edges():
    n = np.fromfile(NODES, dtype=NODE_DT)
    e = np.fromfile(EDGES, dtype=np.dtype([("s", "<u4"), ("t", "<u4")]))
    lo, hi = int(n["id"][0]), int(n["id"][-1])
    lk = np.full(hi - lo + 1, -1, np.int32)
    lk[n["id"] - lo] = np.arange(n.size, dtype=np.int32)
    src = lk[e["s"] - lo]
    dst = lk[e["t"] - lo]
    valid = (src >= 0) & (dst >= 0) & (src != dst)
    return n, src[valid], dst[valid]


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


def build_fft_kernels(G):
    """Kernels Cauchy suaves em duas escalas (não-periódicos via zero-padding 2G x 2G)."""
    P = 2 * G
    dy = np.fft.fftfreq(P, d=1.0 / P).astype(np.float32)[:, None]
    dx = np.fft.fftfreq(P, d=1.0 / P).astype(np.float32)[None, :]
    r2 = dx * dx + dy * dy
    s_med = np.float32(G * 0.055)
    s_loc = np.float32(G * 0.014)
    s_med2 = s_med * s_med
    s_loc2 = s_loc * s_loc
    k_rad = (
        np.float32(0.65) / (s_med2 * np.power(np.float32(1.0) + r2 / s_med2, 2))
        + np.float32(0.35) / (s_loc2 * np.power(np.float32(1.0) + r2 / s_loc2, 2))
    )
    kx = dx * k_rad
    ky = dy * k_rad
    kx[0, 0] = 0.0
    ky[0, 0] = 0.0
    return np.fft.rfft2(kx), np.fft.rfft2(ky)


def fft_repulsion(pos, mass, G, kernels):
    """Repulsão multi-escala suave via convolução FFT não-periódica."""
    kx_hat, ky_hat = kernels
    P = 2 * G
    margin = 3.0
    lo = pos.min(0)
    hi = pos.max(0)
    span = float(max(hi[0] - lo[0], hi[1] - lo[1], 1e-4))
    h = span / (G - 1.0 - 2.0 * margin)

    gx = np.clip((pos[:, 0] - lo[0]) / h + margin, 1.0, G - 2.001)
    gy = np.clip((pos[:, 1] - lo[1]) / h + margin, 1.0, G - 2.001)

    ix = np.floor(gx).astype(np.int32)
    iy = np.floor(gy).astype(np.int32)
    fx = (gx - ix).astype(np.float32)
    fy = (gy - iy).astype(np.float32)

    w00 = (1.0 - fx) * (1.0 - fy) * mass
    w10 = fx * (1.0 - fy) * mass
    w01 = (1.0 - fx) * fy * mass
    w11 = fx * fy * mass

    idx00 = iy * G + ix
    grid_flat = (
        np.bincount(idx00, w00, G * G)
        + np.bincount(idx00 + 1, w10, G * G)
        + np.bincount(idx00 + G, w01, G * G)
        + np.bincount(idx00 + G + 1, w11, G * G)
    )
    pad = np.zeros((P, P), dtype=np.float32)
    pad[:G, :G] = grid_flat.reshape(G, G)

    m_hat = np.fft.rfft2(pad)
    rx_grid = np.fft.irfft2(m_hat * kx_hat, s=(P, P))[:G, :G]
    ry_grid = np.fft.irfft2(m_hat * ky_hat, s=(P, P))[:G, :G]

    rx_flat = rx_grid.ravel()
    ry_flat = ry_grid.ravel()
    b00 = (1.0 - fx) * (1.0 - fy)
    b10 = fx * (1.0 - fy)
    b01 = (1.0 - fx) * fy
    b11 = fx * fy

    frx = (
        rx_flat[idx00] * b00
        + rx_flat[idx00 + 1] * b10
        + rx_flat[idx00 + G] * b01
        + rx_flat[idx00 + G + 1] * b11
    )
    fry = (
        ry_flat[idx00] * b00
        + ry_flat[idx00 + 1] * b10
        + ry_flat[idx00 + G] * b01
        + ry_flat[idx00 + G + 1] * b11
    )
    return frx * mass, fry * mass


def layout_backbone(c1, src, dst, rng):
    """Estágio 1: Backbone em levels[1] via afinidade PPMI espectral + Cauchy t-SNE exato."""
    C1 = int(c1.max()) + 1
    sz1 = np.bincount(c1, minlength=C1).astype(np.float64)
    u = c1[src]
    v = c1[dst]
    m = u != v
    u, v = u[m], v[m]

    A = coo_matrix((np.ones(u.size, np.float64), (u, v)), shape=(C1, C1)).tocsr()
    A = A + A.T
    _, comp = connected_components(A, directed=False)
    giant_id = int(np.argmax(np.bincount(comp)))
    g_idx = np.where(comp == giant_id)[0]
    K = g_idx.size

    Ag = A[g_idx][:, g_idx].tocoo()
    deg_A = np.maximum(np.array(A[g_idx][:, g_idx].sum(axis=1)).ravel(), 1.0)
    tot = deg_A.sum()
    pmi = np.maximum(0.0, np.log((Ag.data * tot) / (deg_A[Ag.row] * deg_A[Ag.col] + 1e-9)))
    w_aff = pmi * np.power(Ag.data, 0.40)
    keep = (Ag.row < Ag.col) & (w_aff > 0)
    er, ec, ew = Ag.row[keep], Ag.col[keep], w_aff[keep]

    An = coo_matrix((ew, (er, ec)), shape=(K, K))
    An = (An + An.T).tocsr()
    dn = np.maximum(np.array(An.sum(axis=1)).ravel(), 1e-8)
    isq = 1.0 / np.sqrt(dn)
    vals, vecs = eigsh(diags(isq) @ An @ diags(isq), k=min(4, K - 1), which="LA")
    ord_v = np.argsort(vals)[::-1]
    coords = vecs[:, ord_v[1:3]] * isq[:, None]
    coords /= max(float(coords.std()), 1e-6)
    coords = (coords * 20.0 + rng.normal(0, 0.8, coords.shape)).astype(np.float64)

    mass = np.power(sz1[g_idx], 0.50)
    mass /= mass.mean()
    ew_n = ew / max(float(ew.mean()), 1e-6)
    vel = np.zeros_like(coords)

    iters = 300
    for it in range(iters):
        span = max(float(np.ptp(coords[:, 0])), float(np.ptp(coords[:, 1])), 1.0)
        sigma2 = (0.18 * span * (0.45 ** (it / iters))) ** 2

        dx = coords[:, 0:1] - coords[:, 0:1].T
        dy = coords[:, 1:2] - coords[:, 1:2].T
        d2 = dx * dx + dy * dy
        q = 1.0 / ((1.0 + d2 / sigma2) ** 2)
        np.fill_diagonal(q, 0.0)
        mm = mass[:, None] * mass[None, :]
        rx = (mm * q * dx).sum(axis=1)
        ry = (mm * q * dy).sum(axis=1)

        adx = coords[ec, 0] - coords[er, 0]
        ady = coords[ec, 1] - coords[er, 1]
        ad2 = adx * adx + ady * ady
        af = ew_n / (1.0 + ad2 / (sigma2 * 2.0))
        ax = np.bincount(er, af * adx, K) - np.bincount(ec, af * adx, K)
        ay = np.bincount(er, af * ady, K) - np.bincount(ec, af * ady, K)

        att_m = np.mean(np.hypot(ax, ay)) + 1e-12
        rep_m = np.mean(np.hypot(rx, ry)) + 1e-12
        scale_r = 0.95 * (att_m / rep_m)
        fx = ax + rx * scale_r
        fy = ay + ry * scale_r

        f_p95 = np.percentile(np.hypot(fx, fy), 95) + 1e-12
        step_target = span * (0.03 * (1.0 - 0.8 * it / iters) + 0.003)
        step = np.column_stack((fx, fy)) * (step_target / f_p95)
        sn = np.hypot(step[:, 0], step[:, 1]) + 1e-9
        step *= np.minimum(1.0, (2.0 * step_target) / sn)[:, None]
        vel = 0.5 * vel + 0.5 * step
        coords += vel
        coords -= np.median(coords, axis=0)

    c1_pos = np.zeros((C1, 2), dtype=np.float32)
    c1_pos[g_idx] = coords.astype(np.float32)
    non_giant = np.where(comp != giant_id)[0]
    if non_giant.size:
        pick = rng.choice(g_idx, size=non_giant.size, p=mass / mass.sum())
        c1_pos[non_giant] = c1_pos[pick] + rng.normal(0, 0.35, (non_giant.size, 2)).astype(np.float32)
    return c1_pos


def run_fft_cauchy(pos, mass, es, et, ew, iters, G, rep_bal=0.92):
    """Refinamento t-SNE/Cauchy via FFT com balanço virial (sem âncora nem gravidade central)."""
    N = pos.shape[0]
    kernels = build_fft_kernels(G)
    vx = np.zeros(N, dtype=np.float32)
    vy = np.zeros(N, dtype=np.float32)
    stride = max(1, N // 200_000)

    for it in range(iters):
        t_it = time.time()
        span = float(max(np.ptp(pos[:, 0]), np.ptp(pos[:, 1]), 1.0))
        s_att2 = np.float32((0.12 * span) ** 2)

        dx = pos[et, 0] - pos[es, 0]
        dy = pos[et, 1] - pos[es, 1]
        d2 = dx * dx + dy * dy
        f = ew / (np.float32(1.0) + d2 / s_att2)
        fx_e = f * dx
        fy_e = f * dy

        ax = (np.bincount(es, fx_e, N) - np.bincount(et, fx_e, N)).astype(np.float32)
        ay = (np.bincount(es, fy_e, N) - np.bincount(et, fy_e, N)).astype(np.float32)

        rx, ry = fft_repulsion(pos, mass, G, kernels)

        att_m = float(np.mean(np.hypot(ax, ay))) + 1e-12
        rep_m = float(np.mean(np.hypot(rx, ry))) + 1e-12
        scale_r = np.float32(rep_bal * att_m / rep_m)
        fx = ax + rx * scale_r
        fy = ay + ry * scale_r

        f_sub = np.hypot(fx[::stride], fy[::stride])
        f_p95 = float(np.percentile(f_sub, 95)) + 1e-12
        step_target = np.float32(span * (0.022 * (1.0 - 0.82 * it / iters) + 0.0025))
        gain = np.float32(step_target / f_p95)
        sx = fx * gain
        sy = fy * gain

        sn = np.hypot(sx, sy) + np.float32(1e-9)
        cap = np.minimum(np.float32(1.0), np.float32(2.2) * step_target / sn)
        vx = np.float32(0.4) * vx + np.float32(0.6) * sx * cap
        vy = np.float32(0.4) * vy + np.float32(0.6) * sy * cap
        pos[:, 0] += vx
        pos[:, 1] += vy

        if (it + 1) % 10 == 0:
            pos -= np.median(pos, axis=0)

        if it % 10 == 0 or it == iters - 1:
            print("  iter %d/%d bbox %.1f x %.1f step %.2f (%.2fs)" % (
                it + 1, iters, np.ptp(pos[:, 0]), np.ptp(pos[:, 1]), step_target, time.time() - t_it))


def layout_fine_communities(comm, c1, c1_pos, src, dst, rng):
    """Estágio 2: Refina as comunidades finas (levels[0]) com repulsão Cauchy FFT."""
    C0 = int(comm.max()) + 1
    size0 = np.bincount(comm, minlength=C0).astype(np.float64)

    c1_of = np.zeros(C0, dtype=np.int32)
    c1_of[comm] = c1

    u = comm[src]
    v = comm[dst]
    m = u != v
    u, v = u[m], v[m]
    a = np.minimum(u, v)
    b = np.maximum(u, v)
    key = a.astype(np.int64) * C0 + b
    uniq, cnt = np.unique(key, return_counts=True)
    ca = (uniq // C0).astype(np.int32)
    cb = (uniq % C0).astype(np.int32)
    del u, v, m, a, b, key, uniq

    c_deg = np.bincount(ca, cnt, C0) + np.bincount(cb, cnt, C0)
    active = np.where(c_deg > 0)[0]
    act_map = np.full(C0, -1, dtype=np.int32)
    act_map[active] = np.arange(active.size, dtype=np.int32)

    pos0 = c1_pos[c1_of].copy()
    span_c1 = max(float(np.ptp(pos0[:, 0])), float(np.ptp(pos0[:, 1])), 1.0)
    wx_sum = np.bincount(ca, cnt * pos0[cb, 0], C0) + np.bincount(cb, cnt * pos0[ca, 0], C0)
    wy_sum = np.bincount(ca, cnt * pos0[cb, 1], C0) + np.bincount(cb, cnt * pos0[ca, 1], C0)
    has_nb = c_deg > 0
    pos0[has_nb, 0] = 0.65 * pos0[has_nb, 0] + 0.35 * (wx_sum[has_nb] / c_deg[has_nb])
    pos0[has_nb, 1] = 0.65 * pos0[has_nb, 1] + 0.35 * (wy_sum[has_nb] / c_deg[has_nb])
    pos0 += rng.normal(0, 0.02 * span_c1, pos0.shape).astype(np.float32)

    pos_act = pos0[active].copy()
    es = act_map[ca]
    et = act_map[cb]
    mass_act = np.power(size0[active] + 1.0, 0.55).astype(np.float32)
    mass_act /= mass_act.mean()

    tot0 = float(cnt.sum()) * 2.0
    pmi = np.maximum(0.0, np.log((cnt * tot0) / (c_deg[ca] * c_deg[cb] + 1e-9)))
    ppmi_w = (pmi * np.power(cnt, 0.35) + 0.1 * np.log1p(cnt)) / np.power((c_deg[ca] + 1.0) * (c_deg[cb] + 1.0), 0.25)
    tether = 0.5 * (cnt / np.maximum(c_deg[ca], 1.0) + cnt / np.maximum(c_deg[cb], 1.0))
    ew = (0.65 * (ppmi_w / max(float(ppmi_w.mean()), 1e-6))
          + 0.35 * (tether / max(float(tether.mean()), 1e-6))).astype(np.float32)
    ew /= max(float(ew.mean()), 1e-6)

    print("Estagio 2: %d comunidades conectadas, %d arestas..." % (active.size, es.size))
    run_fft_cauchy(pos_act, mass_act, es, et, ew, iters=60, G=256, rep_bal=0.92)

    pos0[active] = pos_act
    iso = np.where(~has_nb)[0]
    if iso.size:
        pick = rng.choice(active, size=iso.size)
        pos0[iso] = pos0[pick] + rng.normal(0, 0.003 * span_c1, (iso.size, 2)).astype(np.float32)
    return pos0, size0, active


def preview(pos, comm, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    C = int(comm.max()) + 1
    counts = np.bincount(comm, minlength=C)
    top20 = np.argsort(counts)[::-1][:20]
    hue_idx = np.arange(C, dtype=np.float64) + 20.0
    for rank, c in enumerate(top20):
        hue_idx[c] = float(rank)
    pal = np.zeros((C, 3), dtype=np.float32)
    for c in range(C):
        h = ((hue_idx[c] * 137.508) % 360.0) / 360.0
        pal[c] = colorsys.hls_to_rgb(h, 0.62, 0.85)

    rng = np.random.default_rng(0)
    idx = rng.choice(pos.shape[0], min(400_000, pos.shape[0]), replace=False)
    fig, ax = plt.subplots(figsize=(12, 12), facecolor="#060911")
    ax.set_facecolor("#060911")
    ax.scatter(pos[idx, 0], pos[idx, 1], s=0.18, c=pal[comm[idx]],
               linewidths=0, alpha=0.5)
    ax.set_aspect("equal")
    ax.axis("off")
    plt.tight_layout(pad=0.2)
    plt.savefig(path, dpi=120, facecolor="#060911")
    plt.close(fig)


def main():
    t0 = time.time()
    n, src, dst = load_edges()
    N = n.size
    print("N=%d E=%d" % (N, src.size))

    if not os.path.exists(LEVELS):
        louvain(src, dst, N)
        print("comm_levels.npy salvo. Rode de novo para gerar o layout.")
        return

    levels = np.load(LEVELS)
    comm = levels[0]
    c1 = levels[1]
    rng = np.random.default_rng(42)

    t1 = time.time()
    c1_pos = layout_backbone(c1, src, dst, rng)
    print("Estagio 1 (backbone %d comms levels[1]): %.1fs" % (c1_pos.shape[0], time.time() - t1))

    t2 = time.time()
    comm_pos, size0, active = layout_fine_communities(comm, c1, c1_pos, src, dst, rng)
    print("Estagio 2 concluido em %.1fs" % (time.time() - t2))
    del levels, c1, c1_pos
    gc.collect()

    # Estágio 3: Refinamento livre nos nós conectados (deg > 0)
    deg = (np.bincount(src, minlength=N) + np.bincount(dst, minlength=N)).astype(np.int32)
    conn_mask = deg > 0
    conn_idx = np.where(conn_mask)[0]
    iso_idx = np.where(~conn_mask)[0]
    Nc = conn_idx.size
    node_map = np.full(N, -1, dtype=np.int32)
    node_map[conn_idx] = np.arange(Nc, dtype=np.int32)

    # Inicialização com dispersão proporcional à área da comunidade (sem ruído extremo)
    med_c = np.median(comm_pos[active], axis=0)
    r90_comm = float(np.percentile(
        np.hypot(comm_pos[active, 0] - med_c[0], comm_pos[active, 1] - med_c[1]), 90))
    r_comm = (0.30 * r90_comm * np.sqrt(size0 / N)).astype(np.float32)

    nb_x = np.bincount(src, comm_pos[comm[dst], 0], N) + np.bincount(dst, comm_pos[comm[src], 0], N)
    nb_y = np.bincount(src, comm_pos[comm[dst], 1], N) + np.bincount(dst, comm_pos[comm[src], 1], N)
    d_conn = deg[conn_idx].astype(np.float32)

    pos_conn = np.empty((Nc, 2), dtype=np.float32)
    c_conn = comm[conn_idx]
    pos_conn[:, 0] = 0.55 * comm_pos[c_conn, 0] + 0.45 * (nb_x[conn_idx] / d_conn)
    pos_conn[:, 1] = 0.55 * comm_pos[c_conn, 1] + 0.45 * (nb_y[conn_idx] / d_conn)
    std_i = (r_comm[c_conn] / np.power(np.log2(d_conn + 2.0), 0.35)).astype(np.float32)
    noise = np.clip(rng.normal(0, 1, pos_conn.shape), -2.0, 2.0).astype(np.float32)
    pos_conn += noise * std_i[:, None]
    del nb_x, nb_y, comm_pos, r_comm, std_i, c_conn, active, noise
    gc.collect()

    # Mantém 100% das arestas ligadas a nós de grau <= 25 (zero nós conectados órfãos)
    keep = (np.minimum(deg[src], deg[dst]) <= 25) | ((np.arange(src.size) & 1) == 0)
    es = node_map[src[keep]]
    et = node_map[dst[keep]]
    del node_map, src, dst, keep
    gc.collect()

    mass = np.power(d_conn, 0.35).astype(np.float32)
    mass /= mass.mean()
    d_sub = (np.bincount(es, minlength=Nc) + np.bincount(et, minlength=Nc)).astype(np.float32)
    ew = (
        0.75 * (1.0 / np.maximum(d_sub[es], 1.0) + 1.0 / np.maximum(d_sub[et], 1.0))
        + 0.25 * np.power((d_conn[es] + 2.0) * (d_conn[et] + 2.0), -0.42)
    ).astype(np.float32)
    ew /= max(float(ew.mean()), 1e-6)
    del d_sub

    t3 = time.time()
    print("Estagio 3: %d nos conectados, %d arestas preservadas..." % (Nc, es.size))
    run_fft_cauchy(pos_conn, mass, es, et, ew, iters=32, G=512, rep_bal=0.88)
    print("Estagio 3 concluido em %.1fs" % (time.time() - t3))

    # Compactação de folhas soltas (2 passagens) em direção aos vizinhos conectados
    s_step = max(1, es.size // 500_000)
    med_elen = float(np.median(np.hypot(
        pos_conn[et[::s_step], 0] - pos_conn[es[::s_step], 0],
        pos_conn[et[::s_step], 1] - pos_conn[es[::s_step], 1],
    )))
    for _ in range(2):
        w_sum = np.bincount(es, ew, Nc) + np.bincount(et, ew, Nc)
        nx = (np.bincount(es, ew * pos_conn[et, 0], Nc) + np.bincount(et, ew * pos_conn[es, 0], Nc)) / np.maximum(w_sum, 1e-8)
        ny = (np.bincount(es, ew * pos_conn[et, 1], Nc) + np.bincount(et, ew * pos_conn[es, 1], Nc)) / np.maximum(w_sum, 1e-8)
        dist_nb = np.hypot(pos_conn[:, 0] - nx, pos_conn[:, 1] - ny)
        stray = (d_conn <= 4) & (dist_nb > 2.2 * med_elen)
        pos_conn[stray, 0] = 0.30 * pos_conn[stray, 0] + 0.70 * nx[stray]
        pos_conn[stray, 1] = 0.30 * pos_conn[stray, 1] + 0.70 * ny[stray]
    print("Compactacao de folhas soltas concluida (med_elen=%.2f)" % med_elen)

    del es, et, ew, mass
    gc.collect()

    # Normalização isotrópica por percentil 98 (preserva assimetria, razão de aspecto e filamentos livres)
    med = np.median(pos_conn, axis=0)
    pos_conn -= med
    r98 = float(np.percentile(np.hypot(pos_conn[:, 0], pos_conn[:, 1]), 98))
    scale = 1.0 / max(r98, 1e-6)
    pos_conn *= scale

    pos = np.empty((N, 2), dtype=np.float32)
    pos[conn_idx] = pos_conn
    if iso_idx.size:
        pick = rng.choice(conn_idx, size=iso_idx.size, p=d_conn / d_conn.sum())
        pos[iso_idx] = pos[pick] + rng.normal(0, 0.004, (iso_idx.size, 2)).astype(np.float32)
    del d_conn

    print("Coordenadas finais: X [%.3f, %.3f] Y [%.3f, %.3f] (r98=%.3f antes de norm)" % (
        pos[:, 0].min(), pos[:, 0].max(), pos[:, 1].min(), pos[:, 1].max(), r98))

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
    print("nodes.bin atualizado em %.1fs totais" % (time.time() - t0))


if __name__ == "__main__":
    main()
