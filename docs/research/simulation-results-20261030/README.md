# Simulation results — 2026-10-30 (synthetic data)

Generated on 2026-10-30 from `integration/d1-wpsa-wrr` @ `6213aa0` plus `backend/simulation/report.js`
(branch `docs/sim-wpsa-wrr-report`), Node.js v24.21.0, Windows 11. Report:
[`../wps-a-vs-wrr-simulation-report-20261030.md`](../wps-a-vs-wrr-simulation-report-20261030.md).

**Synthetic patients only.** No City Health data and no database were used.

## Inputs

| Input | Value |
|---|---|
| Scenarios | low-volume, medium-volume, high-volume, priority-surge, unequal-workload, long-waits (`backend/simulation/scenarios.js`) |
| Replications | 30 per scenario |
| Seeds | 20261029 – 20261058 (seed = 20261029 + replication index); one workload per seed, shared by every policy and structure |
| Policies | WPS (original), WPS-A (10-minute aging, +2 cap), WRR (weights = priority score) |
| Queue structures | service (legacy fixed doctor per service), shared (D1 Model A, three general doctors) |
| Doctors | Doctor 1, 2, 3 available all day, no breaks |
| Sample trace | scenario long-waits, seed 20261029, shared queue |

## Commands (from `backend/`)

```bash
node simulation/run.js ../docs/research/simulation-results-20261030 30 20261029
```

```bash
node simulation/report.js ../docs/research/simulation-results-20261030 long-waits 20261029
```

```bash
node --test test/simulation.test.js test/simulation-report.test.js
```

`.gitattributes` in this folder stores the files byte for byte (no line-ending conversion), so the hashes
below can be checked after a checkout on any platform, e.g. `sha256sum -c` on the list below.

## SHA-256

```text
bdfeffee0c62e7a4fca2903bcb58d1a8636cf49aaf88a0ccab4e3e0ec18d1930  charts/effects-policy-only.svg
37d5b96c5c89a0f95f04e169585a2e4a1ce1a87b59bbcbda5dd142ee96c5ea80  charts/effects-structure-vs-policy.svg
5392e03abe3298099f7134b69c318268e9603afc69690f85bf6f868cbb34d9ec  charts/head-to-head-wrr-vs-wpsa.svg
2d23bcfcc7b70ce1c3a53e8b989d56d9cc656be762e19d7f492173aecace19f4  charts/protected-ordering.svg
b10439fa5f83d3cde4bc2823e33ad4e7f73ea946819675d161278c6b0338f5cb  charts/throughput.svg
8cff8a40000b9252a6f227d2472f6e6a89278763ff19b38c9d80f5e10cc6b2eb  charts/utilization.svg
42c4cdaf61a8fb47a30b1877d37e739df9d8de8dd34f90261e2f6dac9b259110  charts/wait-avg.svg
6fd82e3dea001e8ad5b4df3dd3fb0e1ffacdec51389a57dfc912b8e8f5ec15a5  charts/wait-by-group-long-waits.svg
0393c31b8c825cc1e7b1e0158c51bf1664860e4faa8f53890c39a7da37227c60  charts/wait-by-group-priority-surge.svg
90987b142cc88d08603e02b53b8706fa94cf469e242f5c9b3abc8a2f7e5ab99f  charts/wait-max.svg
e183f542f06dde6b809c1dbdc0f2b5fd8708b773bc65ac6a754055311557d1a1  charts/wait-p95.svg
7a12af0e4b70e99ea6fa49f8777b01d0b23c6a278bb62660c0c81a3d698c6f36  head-to-head.json
152112e93683bc731714055cbb1ccbb0571abc0769eb9fbd83d08ce1f32cdff8  head-to-head.md
c28a6c201e6b9a82dac961e930f50f0d79edec021fab6e416278e02f286438f6  paired-effects.json
5ea3b3e25a5a3f09ea4a134ad1534f69fa51f708313e60713eeb310f8d13191c  paired-effects.md
53afa4cb1874c66bf2345a5dfac07bf1504ce7d289b67521fdb908be43c766fb  per-replication.csv
7c8fdae3084934e66ebfb759e6b5d527b4e481ba8331093816aecce2fa5b8bb4  results.json
7f595b36f39cdae5ce5ea705218254655f9a8e8fc28d188c532ea0649c93fad1  results.md
6eaebca617d6b8148ec482209efb6c21168f795087d6bb833133392680df3091  sample-trace.json
5110058be536aeab59c093912a396dff12ce9f3c6de5a89575bc5165321454e4  sample-trace.md
eda8b2878ff3c6e3cb572d2895f628f78682e5da351fcd28525b260b5eded7ba  tables.md
```
