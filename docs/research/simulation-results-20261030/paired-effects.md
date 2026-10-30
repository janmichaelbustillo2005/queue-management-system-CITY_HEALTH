# Paired effects: queue structure versus scheduling policy

Each value is the per-seed difference (minutes) between two runs on the same 30 synthetic workloads, as mean ± 95% CI.
Negative means shorter waits. "Better / worse seeds" counts seeds where the change shortened / lengthened that wait.

## Queue structure: shared − service (both WPS)

| Scenario | Average wait | P95 wait | Maximum wait | Better / worse seeds (max wait) |
|---|---|---|---|---|
| low-volume | -4.7 ± 1.1 | -20.6 ± 5.9 | -30.4 ± 7.5 | 30 / 0 |
| medium-volume | -22.1 ± 6.1 | -78.0 ± 21.4 | -96.4 ± 19.7 | 30 / 0 |
| high-volume | -46.9 ± 6.7 | -167.7 ± 24.4 | -183.0 ± 22.0 | 30 / 0 |
| priority-surge | -19.7 ± 5.3 | -102.1 ± 31.4 | -146.3 ± 33.8 | 30 / 0 |
| unequal-workload | -100.2 ± 14.5 | -268.4 ± 30.1 | -276.9 ± 28.5 | 30 / 0 |
| long-waits | -48.0 ± 6.6 | -182.0 ± 22.4 | -194.5 ± 19.5 | 30 / 0 |

## Policy in the shared queue: WPS-A − WPS

| Scenario | Average wait | P95 wait | Maximum wait | Better / worse seeds (max wait) |
|---|---|---|---|---|
| low-volume | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.0 ± 0.0 | 0 / 0 |
| medium-volume | 0.0 ± 0.0 | 0.0 ± 0.0 | -0.1 ± 0.2 | 1 / 0 |
| high-volume | 0.0 ± 0.0 | -0.4 ± 0.6 | -0.8 ± 1.0 | 15 / 8 |
| priority-surge | 0.0 ± 0.0 | 0.2 ± 0.3 | 0.1 ± 0.3 | 1 / 2 |
| unequal-workload | 0.0 ± 0.0 | -0.2 ± 0.3 | -0.2 ± 0.3 | 3 / 0 |
| long-waits | 0.0 ± 0.0 | -0.2 ± 0.4 | -0.7 ± 0.8 | 15 / 10 |

## Policy in the shared queue: WRR − WPS

| Scenario | Average wait | P95 wait | Maximum wait | Better / worse seeds (max wait) |
|---|---|---|---|---|
| low-volume | 0.0 ± 0.0 | 0.0 ± 0.1 | -0.3 ± 0.3 | 5 / 0 |
| medium-volume | 0.0 ± 0.0 | -0.5 ± 0.5 | -1.0 ± 0.6 | 14 / 6 |
| high-volume | -0.1 ± 0.1 | -0.4 ± 0.4 | -1.1 ± 1.1 | 21 / 8 |
| priority-surge | 0.0 ± 0.0 | -0.2 ± 0.8 | -4.0 ± 1.8 | 20 / 3 |
| unequal-workload | 0.0 ± 0.0 | -0.1 ± 0.4 | -0.4 ± 0.8 | 13 / 5 |
| long-waits | 0.0 ± 0.1 | -0.6 ± 0.5 | -1.1 ± 1.3 | 12 / 18 |

## Policy in service dispatch: WPS-A − WPS

| Scenario | Average wait | P95 wait | Maximum wait | Better / worse seeds (max wait) |
|---|---|---|---|---|
| low-volume | 0.0 ± 0.0 | 0.0 ± 0.0 | -0.2 ± 0.4 | 1 / 0 |
| medium-volume | 0.0 ± 0.0 | -0.5 ± 0.6 | 0.0 ± 0.0 | 0 / 0 |
| high-volume | 0.0 ± 0.0 | -0.2 ± 0.3 | 0.0 ± 0.1 | 1 / 0 |
| priority-surge | 0.0 ± 0.1 | -2.8 ± 2.6 | 0.0 ± 0.0 | 0 / 0 |
| unequal-workload | 0.0 ± 0.1 | -0.1 ± 0.1 | -0.5 ± 1.1 | 1 / 0 |
| long-waits | 0.0 ± 0.1 | -0.3 ± 0.3 | 0.0 ± 0.0 | 0 / 0 |

## Policy in service dispatch: WRR − WPS

| Scenario | Average wait | P95 wait | Maximum wait | Better / worse seeds (max wait) |
|---|---|---|---|---|
| low-volume | 0.0 ± 0.0 | 0.0 ± 0.8 | -0.7 ± 1.2 | 4 / 0 |
| medium-volume | 0.0 ± 0.0 | -0.6 ± 1.0 | -7.2 ± 6.2 | 6 / 0 |
| high-volume | 0.2 ± 0.1 | -0.5 ± 0.6 | -5.9 ± 6.8 | 3 / 0 |
| priority-surge | 0.1 ± 0.5 | -24.8 ± 8.5 | -38.2 ± 10.8 | 28 / 0 |
| unequal-workload | 0.0 ± 0.2 | -0.2 ± 0.2 | -0.3 ± 0.4 | 2 / 0 |
| long-waits | 0.1 ± 0.2 | -0.7 ± 1.0 | -4.5 ± 5.8 | 3 / 0 |
