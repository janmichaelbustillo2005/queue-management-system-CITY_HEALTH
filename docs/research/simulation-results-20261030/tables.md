# Comparison tables

Synthetic workloads only. 30 paired replications per scenario (seeds 20261029–20261058); every policy and both dispatch modes serve the identical patients for a seed. Values: mean ± 95% CI, minutes unless stated.

## Waiting time

| Scenario | Dispatch | Policy | Average | P95 | Maximum | Waits > 60 min (count) |
|---|---|---|---|---|---|---|
| low-volume | service | WPS | 5.3 ± 1.2 | 24.7 ± 6.4 | 39.5 ± 8.2 | 0.5 ± 0.6 |
| low-volume | service | WPS-A | 5.4 ± 1.2 | 24.7 ± 6.4 | 39.2 ± 8.3 | 0.5 ± 0.6 |
| low-volume | service | WRR | 5.3 ± 1.2 | 24.8 ± 6.3 | 38.8 ± 7.9 | 0.5 ± 0.6 |
| low-volume | shared | WPS | 0.7 ± 0.2 | 4.1 ± 1.1 | 9.1 ± 1.8 | 0.0 ± 0.0 |
| low-volume | shared | WPS-A | 0.7 ± 0.2 | 4.1 ± 1.1 | 9.1 ± 1.8 | 0.0 ± 0.0 |
| low-volume | shared | WRR | 0.6 ± 0.2 | 4.1 ± 1.0 | 8.8 ± 1.7 | 0.0 ± 0.0 |
| medium-volume | service | WPS | 25.9 ± 6.5 | 95.3 ± 22.2 | 123.2 ± 21.3 | 15.2 ± 5.4 |
| medium-volume | service | WPS-A | 25.9 ± 6.5 | 94.8 ± 22.1 | 123.2 ± 21.3 | 15.1 ± 5.3 |
| medium-volume | service | WRR | 26.0 ± 6.5 | 94.6 ± 21.9 | 116.0 ± 22.3 | 15.0 ± 5.4 |
| medium-volume | shared | WPS | 3.8 ± 0.9 | 17.3 ± 3.5 | 26.8 ± 3.6 | 0.0 ± 0.0 |
| medium-volume | shared | WPS-A | 3.8 ± 0.9 | 17.3 ± 3.5 | 26.7 ± 3.5 | 0.0 ± 0.0 |
| medium-volume | shared | WRR | 3.8 ± 0.9 | 16.7 ± 3.4 | 25.8 ± 3.5 | 0.0 ± 0.0 |
| high-volume | service | WPS | 68.5 ± 10.4 | 234.1 ± 30.3 | 262.1 ± 28.5 | 46.3 ± 4.9 |
| high-volume | service | WPS-A | 68.5 ± 10.4 | 233.9 ± 30.5 | 262.0 ± 28.5 | 46.0 ± 4.9 |
| high-volume | service | WRR | 68.7 ± 10.4 | 233.6 ± 30.5 | 256.2 ± 31.1 | 46.6 ± 5.0 |
| high-volume | shared | WPS | 21.6 ± 5.6 | 66.4 ± 10.9 | 79.1 ± 11.5 | 18.2 ± 9.0 |
| high-volume | shared | WPS-A | 21.5 ± 5.6 | 66.0 ± 10.9 | 78.3 ± 11.4 | 18.0 ± 9.0 |
| high-volume | shared | WRR | 21.5 ± 5.6 | 66.0 ± 10.9 | 77.9 ± 11.4 | 17.9 ± 9.0 |
| priority-surge | service | WPS | 23.9 ± 5.7 | 123.7 ± 32.7 | 185.0 ± 36.0 | 9.8 ± 2.8 |
| priority-surge | service | WPS-A | 23.9 ± 5.7 | 120.9 ± 32.9 | 185.0 ± 36.0 | 9.7 ± 2.8 |
| priority-surge | service | WRR | 24.0 ± 5.8 | 98.9 ± 27.2 | 146.8 ± 32.5 | 11.1 ± 4.2 |
| priority-surge | shared | WPS | 4.3 ± 1.1 | 21.7 ± 5.7 | 38.7 ± 7.1 | 0.7 ± 0.7 |
| priority-surge | shared | WPS-A | 4.3 ± 1.1 | 21.8 ± 5.7 | 38.7 ± 7.1 | 0.7 ± 0.7 |
| priority-surge | shared | WRR | 4.3 ± 1.1 | 21.5 ± 5.4 | 34.6 ± 6.4 | 0.4 ± 0.5 |
| unequal-workload | service | WPS | 104.1 ± 15.0 | 286.2 ± 31.3 | 305.0 ± 30.9 | 50.1 ± 3.3 |
| unequal-workload | service | WPS-A | 104.1 ± 15.0 | 286.1 ± 31.4 | 304.5 ± 31.0 | 50.0 ± 3.3 |
| unequal-workload | service | WRR | 104.1 ± 14.9 | 286.0 ± 31.4 | 304.7 ± 30.9 | 49.8 ± 3.4 |
| unequal-workload | shared | WPS | 3.9 ± 1.1 | 17.8 ± 3.5 | 28.2 ± 4.7 | 0.1 ± 0.2 |
| unequal-workload | shared | WPS-A | 3.9 ± 1.1 | 17.7 ± 3.4 | 27.9 ± 4.7 | 0.1 ± 0.2 |
| unequal-workload | shared | WRR | 3.9 ± 1.1 | 17.7 ± 3.5 | 27.8 ± 4.5 | 0.1 ± 0.2 |
| long-waits | service | WPS | 93.2 ± 11.4 | 297.1 ± 30.8 | 322.2 ± 28.3 | 59.2 ± 4.9 |
| long-waits | service | WPS-A | 93.2 ± 11.3 | 296.8 ± 30.8 | 322.2 ± 28.3 | 58.9 ± 4.9 |
| long-waits | service | WRR | 93.3 ± 11.4 | 296.4 ± 30.9 | 317.7 ± 30.7 | 59.9 ± 5.1 |
| long-waits | shared | WPS | 45.2 ± 8.4 | 115.1 ± 16.2 | 127.7 ± 16.5 | 55.2 ± 11.0 |
| long-waits | shared | WPS-A | 45.2 ± 8.4 | 114.9 ± 16.2 | 127.0 ± 16.6 | 55.0 ± 11.0 |
| long-waits | shared | WRR | 45.2 ± 8.4 | 114.5 ± 16.2 | 126.5 ± 16.3 | 54.6 ± 10.9 |

## Average wait by priority group

| Scenario | Dispatch | Policy | Senior | PWD | Pregnant | Indigenous | Solo parent | Multiple | Regular |
|---|---|---|---|---|---|---|---|---|---|
| low-volume | service | WPS | 3.9 ± 1.4 | 2.2 ± 1.0 | 4.4 ± 1.5 | 3.7 ± 1.8 | 5.5 ± 2.3 | 3.0 ± 1.7 | 6.2 ± 1.6 |
| low-volume | service | WPS-A | 3.9 ± 1.4 | 2.2 ± 1.0 | 4.3 ± 1.5 | 4.0 ± 1.8 | 5.5 ± 2.3 | 3.1 ± 1.7 | 6.2 ± 1.6 |
| low-volume | service | WRR | 4.0 ± 1.3 | 2.2 ± 1.0 | 4.4 ± 1.5 | 3.1 ± 1.1 | 4.8 ± 1.7 | 8.2 ± 6.3 | 6.1 ± 1.6 |
| low-volume | shared | WPS | 0.5 ± 0.2 | 1.0 ± 0.8 | 0.7 ± 0.3 | 0.5 ± 0.3 | 0.5 ± 0.3 | 0.3 ± 0.3 | 0.7 ± 0.2 |
| low-volume | shared | WPS-A | 0.5 ± 0.2 | 1.0 ± 0.8 | 0.7 ± 0.3 | 0.5 ± 0.3 | 0.5 ± 0.3 | 0.3 ± 0.3 | 0.7 ± 0.2 |
| low-volume | shared | WRR | 0.5 ± 0.2 | 1.0 ± 0.8 | 0.7 ± 0.3 | 0.4 ± 0.3 | 0.5 ± 0.3 | 0.7 ± 0.9 | 0.7 ± 0.2 |
| medium-volume | service | WPS | 6.2 ± 0.9 | 6.7 ± 1.2 | 7.6 ± 2.3 | 7.4 ± 1.7 | 26.9 ± 9.1 | 5.0 ± 1.3 | 39.1 ± 10.5 |
| medium-volume | service | WPS-A | 6.2 ± 0.9 | 6.6 ± 1.2 | 7.5 ± 2.2 | 9.9 ± 2.7 | 26.9 ± 9.1 | 5.1 ± 1.3 | 38.9 ± 10.5 |
| medium-volume | service | WRR | 7.1 ± 1.0 | 6.9 ± 1.2 | 8.6 ± 2.7 | 6.7 ± 1.5 | 25.9 ± 9.0 | 10.0 ± 3.4 | 38.5 ± 10.6 |
| medium-volume | shared | WPS | 1.8 ± 0.3 | 2.1 ± 0.9 | 1.9 ± 0.4 | 1.9 ± 0.6 | 4.5 ± 1.7 | 1.3 ± 0.4 | 5.1 ± 1.3 |
| medium-volume | shared | WPS-A | 1.8 ± 0.3 | 2.1 ± 0.9 | 1.9 ± 0.4 | 2.1 ± 0.7 | 4.5 ± 1.7 | 1.3 ± 0.4 | 5.1 ± 1.3 |
| medium-volume | shared | WRR | 2.2 ± 0.4 | 2.2 ± 0.9 | 2.1 ± 0.5 | 1.9 ± 0.6 | 4.4 ± 1.7 | 2.5 ± 0.7 | 4.9 ± 1.3 |
| high-volume | service | WPS | 7.0 ± 0.9 | 8.1 ± 1.4 | 13.7 ± 2.6 | 10.6 ± 2.4 | 79.9 ± 15.9 | 4.9 ± 0.7 | 108.9 ± 17.1 |
| high-volume | service | WPS-A | 7.1 ± 1.0 | 8.1 ± 1.3 | 13.6 ± 2.5 | 15.4 ± 2.4 | 79.4 ± 16.0 | 5.3 ± 0.8 | 108.6 ± 17.1 |
| high-volume | service | WRR | 11.2 ± 1.9 | 9.2 ± 1.6 | 17.8 ± 4.5 | 9.7 ± 1.9 | 77.6 ± 15.4 | 12.8 ± 2.5 | 107.0 ± 17.2 |
| high-volume | shared | WPS | 2.4 ± 0.3 | 3.7 ± 0.8 | 3.6 ± 0.4 | 4.9 ± 0.9 | 32.0 ± 8.4 | 2.4 ± 0.4 | 32.9 ± 8.6 |
| high-volume | shared | WPS-A | 2.5 ± 0.2 | 3.6 ± 0.7 | 3.6 ± 0.4 | 8.2 ± 1.5 | 31.9 ± 8.4 | 2.4 ± 0.4 | 32.6 ± 8.5 |
| high-volume | shared | WRR | 3.7 ± 0.4 | 4.4 ± 0.9 | 4.0 ± 0.6 | 4.2 ± 0.7 | 31.7 ± 8.5 | 3.8 ± 0.6 | 32.4 ± 8.6 |
| priority-surge | service | WPS | 12.4 ± 2.2 | 29.9 ± 11.1 | 7.4 ± 2.3 | 4.2 ± 1.5 | 10.2 ± 2.7 | 4.7 ± 0.8 | 45.4 ± 12.4 |
| priority-surge | service | WPS-A | 13.5 ± 2.6 | 25.2 ± 9.3 | 7.4 ± 2.2 | 5.1 ± 2.3 | 10.1 ± 2.7 | 4.6 ± 0.7 | 45.4 ± 12.4 |
| priority-surge | service | WRR | 24.9 ± 7.1 | 14.1 ± 2.7 | 8.4 ± 3.0 | 4.2 ± 1.5 | 9.3 ± 2.3 | 13.3 ± 3.3 | 36.0 ± 9.9 |
| priority-surge | shared | WPS | 1.5 ± 0.2 | 2.5 ± 0.8 | 2.6 ± 0.5 | 4.4 ± 2.4 | 7.7 ± 3.5 | 1.2 ± 0.3 | 7.5 ± 2.3 |
| priority-surge | shared | WPS-A | 1.5 ± 0.2 | 2.7 ± 0.9 | 2.6 ± 0.5 | 4.4 ± 2.4 | 7.7 ± 3.5 | 1.2 ± 0.3 | 7.5 ± 2.3 |
| priority-surge | shared | WRR | 2.1 ± 0.4 | 3.1 ± 1.0 | 2.8 ± 0.6 | 3.0 ± 1.8 | 6.9 ± 3.1 | 2.4 ± 0.6 | 6.8 ± 2.2 |
| unequal-workload | service | WPS | 8.3 ± 0.9 | 11.4 ± 2.5 | 5.4 ± 1.2 | 19.0 ± 5.2 | 143.4 ± 26.8 | 5.7 ± 1.5 | 167.2 ± 24.9 |
| unequal-workload | service | WPS-A | 8.9 ± 1.1 | 11.1 ± 2.3 | 5.0 ± 0.9 | 23.5 ± 5.3 | 143.3 ± 26.8 | 5.8 ± 1.5 | 166.9 ± 24.8 |
| unequal-workload | service | WRR | 13.2 ± 2.0 | 12.5 ± 2.9 | 5.1 ± 0.9 | 14.5 ± 3.1 | 142.3 ± 26.8 | 12.3 ± 3.4 | 165.8 ± 24.6 |
| unequal-workload | shared | WPS | 1.3 ± 0.2 | 2.0 ± 0.5 | 1.4 ± 0.3 | 2.1 ± 0.5 | 4.9 ± 2.1 | 1.2 ± 0.3 | 5.5 ± 1.7 |
| unequal-workload | shared | WPS-A | 1.3 ± 0.2 | 2.0 ± 0.5 | 1.4 ± 0.3 | 2.3 ± 0.7 | 4.9 ± 2.1 | 1.2 ± 0.4 | 5.4 ± 1.6 |
| unequal-workload | shared | WRR | 1.7 ± 0.3 | 2.0 ± 0.5 | 1.4 ± 0.3 | 1.9 ± 0.5 | 4.7 ± 2.0 | 1.7 ± 0.6 | 5.4 ± 1.6 |
| long-waits | service | WPS | 7.5 ± 1.0 | 9.5 ± 1.8 | 17.9 ± 4.1 | 11.3 ± 2.9 | 115.3 ± 19.9 | 6.1 ± 1.1 | 149.1 ± 18.4 |
| long-waits | service | WPS-A | 7.9 ± 1.1 | 9.4 ± 1.9 | 17.7 ± 4.0 | 19.6 ± 3.4 | 114.8 ± 19.9 | 6.4 ± 1.1 | 148.4 ± 18.4 |
| long-waits | service | WRR | 12.6 ± 3.0 | 10.1 ± 1.6 | 24.2 ± 7.4 | 9.4 ± 1.8 | 112.0 ± 19.3 | 16.3 ± 2.9 | 146.2 ± 18.5 |
| long-waits | shared | WPS | 2.7 ± 0.3 | 4.1 ± 0.7 | 4.2 ± 0.6 | 5.9 ± 1.1 | 71.8 ± 13.1 | 2.5 ± 0.5 | 71.4 ± 13.0 |
| long-waits | shared | WPS-A | 2.5 ± 0.3 | 4.0 ± 0.6 | 4.3 ± 0.5 | 12.1 ± 1.5 | 71.3 ± 13.0 | 2.5 ± 0.5 | 71.0 ± 13.0 |
| long-waits | shared | WRR | 4.6 ± 0.4 | 4.8 ± 0.7 | 5.0 ± 0.8 | 4.9 ± 0.7 | 70.8 ± 12.8 | 4.9 ± 0.9 | 70.8 ± 13.0 |

## Maximum wait by priority group

| Scenario | Dispatch | Policy | Senior | PWD | Pregnant | Indigenous | Solo parent | Multiple | Regular |
|---|---|---|---|---|---|---|---|---|---|
| low-volume | service | WPS | 12.0 ± 4.2 | 4.6 ± 1.7 | 19.2 ± 5.3 | 8.5 ± 5.0 | 16.5 ± 8.6 | 5.0 ± 2.8 | 37.1 ± 8.4 |
| low-volume | service | WPS-A | 12.0 ± 4.2 | 4.6 ± 1.7 | 18.7 ± 5.0 | 9.1 ± 5.0 | 16.5 ± 8.6 | 5.3 ± 2.9 | 36.9 ± 8.4 |
| low-volume | service | WRR | 12.2 ± 3.3 | 4.5 ± 1.6 | 19.6 ± 5.4 | 6.8 ± 2.8 | 14.3 ± 6.4 | 12.2 ± 7.4 | 35.4 ± 8.1 |
| low-volume | shared | WPS | 2.3 ± 1.0 | 2.1 ± 1.3 | 4.3 ± 1.7 | 1.7 ± 1.0 | 1.9 ± 1.0 | 0.6 ± 0.4 | 8.4 ± 2.1 |
| low-volume | shared | WPS-A | 2.3 ± 1.0 | 2.1 ± 1.3 | 4.3 ± 1.7 | 1.7 ± 1.0 | 1.9 ± 1.0 | 0.6 ± 0.4 | 8.4 ± 2.1 |
| low-volume | shared | WRR | 2.6 ± 1.1 | 2.0 ± 1.1 | 4.3 ± 1.7 | 1.6 ± 0.9 | 1.9 ± 1.0 | 1.0 ± 0.9 | 8.0 ± 1.9 |
| medium-volume | service | WPS | 18.0 ± 3.3 | 20.1 ± 5.0 | 27.9 ± 6.4 | 20.0 ± 6.0 | 77.9 ± 23.8 | 10.3 ± 2.7 | 121.3 ± 21.6 |
| medium-volume | service | WPS-A | 18.0 ± 3.3 | 20.0 ± 5.0 | 27.8 ± 6.4 | 22.3 ± 6.2 | 77.9 ± 23.8 | 10.5 ± 2.7 | 121.3 ± 21.6 |
| medium-volume | service | WRR | 20.5 ± 4.5 | 20.2 ± 4.7 | 31.7 ± 7.3 | 17.4 ± 4.3 | 73.2 ± 23.5 | 21.9 ± 7.0 | 115.5 ± 22.5 |
| medium-volume | shared | WPS | 7.1 ± 1.5 | 5.3 ± 1.4 | 9.2 ± 1.9 | 5.2 ± 1.7 | 15.2 ± 4.1 | 3.0 ± 1.0 | 26.8 ± 3.6 |
| medium-volume | shared | WPS-A | 7.1 ± 1.5 | 5.3 ± 1.4 | 9.2 ± 1.9 | 5.8 ± 1.9 | 15.2 ± 4.1 | 3.0 ± 1.0 | 26.7 ± 3.5 |
| medium-volume | shared | WRR | 9.1 ± 1.5 | 5.8 ± 1.7 | 10.1 ± 2.1 | 4.9 ± 1.6 | 14.1 ± 4.0 | 6.3 ± 1.8 | 25.5 ± 3.7 |
| high-volume | service | WPS | 19.7 ± 3.8 | 20.8 ± 4.0 | 43.6 ± 7.2 | 31.0 ± 7.7 | 221.5 ± 34.7 | 11.2 ± 2.1 | 261.9 ± 28.5 |
| high-volume | service | WPS-A | 19.8 ± 3.8 | 20.7 ± 4.0 | 43.2 ± 7.2 | 35.4 ± 6.9 | 221.3 ± 34.7 | 12.5 ± 2.6 | 261.9 ± 28.6 |
| high-volume | service | WRR | 31.9 ± 6.5 | 23.6 ± 5.2 | 54.6 ± 10.3 | 27.2 ± 6.5 | 220.7 ± 34.7 | 31.9 ± 6.2 | 255.6 ± 31.5 |
| high-volume | shared | WPS | 7.4 ± 0.9 | 9.6 ± 1.9 | 13.5 ± 1.7 | 14.0 ± 3.1 | 66.7 ± 11.6 | 5.5 ± 1.1 | 78.8 ± 11.5 |
| high-volume | shared | WPS-A | 7.5 ± 0.9 | 9.8 ± 1.9 | 13.6 ± 2.0 | 16.5 ± 2.6 | 66.9 ± 11.8 | 5.3 ± 1.0 | 77.7 ± 11.4 |
| high-volume | shared | WRR | 12.9 ± 2.1 | 11.2 ± 2.3 | 14.8 ± 2.5 | 11.5 ± 2.1 | 66.6 ± 11.9 | 9.4 ± 2.1 | 77.3 ± 11.5 |
| priority-surge | service | WPS | 39.7 ± 6.2 | 87.7 ± 24.3 | 27.2 ± 6.6 | 6.1 ± 1.8 | 26.5 ± 9.3 | 12.0 ± 1.9 | 183.8 ± 36.3 |
| priority-surge | service | WPS-A | 41.6 ± 6.9 | 71.1 ± 21.3 | 27.2 ± 6.6 | 7.0 ± 2.4 | 26.1 ± 9.2 | 12.1 ± 2.1 | 183.8 ± 36.3 |
| priority-surge | service | WRR | 66.4 ± 14.0 | 39.7 ± 7.3 | 29.8 ± 7.7 | 6.1 ± 1.8 | 21.9 ± 5.2 | 31.9 ± 7.2 | 146.1 ± 32.8 |
| priority-surge | shared | WPS | 8.2 ± 1.2 | 8.4 ± 1.9 | 13.4 ± 2.6 | 7.4 ± 4.3 | 19.5 ± 7.6 | 4.4 ± 0.9 | 38.0 ± 7.0 |
| priority-surge | shared | WPS-A | 8.3 ± 1.2 | 8.9 ± 2.0 | 13.2 ± 2.6 | 7.0 ± 3.2 | 19.6 ± 7.6 | 4.4 ± 0.9 | 38.1 ± 7.0 |
| priority-surge | shared | WRR | 11.6 ± 1.6 | 11.2 ± 2.8 | 13.0 ± 2.7 | 4.0 ± 1.9 | 17.1 ± 6.5 | 8.7 ± 2.2 | 33.4 ± 6.5 |
| unequal-workload | service | WPS | 23.7 ± 5.4 | 29.2 ± 6.3 | 30.2 ± 11.1 | 45.4 ± 11.3 | 266.6 ± 34.2 | 11.6 ± 4.1 | 305.0 ± 30.9 |
| unequal-workload | service | WPS-A | 24.3 ± 5.8 | 28.0 ± 5.6 | 24.8 ± 5.5 | 48.5 ± 12.3 | 266.6 ± 34.2 | 12.0 ± 4.0 | 304.5 ± 31.0 |
| unequal-workload | service | WRR | 39.5 ± 7.7 | 30.8 ± 5.4 | 25.3 ± 5.3 | 35.1 ± 8.5 | 266.6 ± 34.2 | 25.1 ± 7.2 | 304.7 ± 30.9 |
| unequal-workload | shared | WPS | 6.3 ± 1.3 | 6.6 ± 1.7 | 6.5 ± 1.7 | 6.2 ± 1.6 | 15.0 ± 5.8 | 3.0 ± 0.8 | 28.0 ± 4.6 |
| unequal-workload | shared | WPS-A | 6.3 ± 1.3 | 6.6 ± 1.7 | 6.5 ± 1.7 | 6.6 ± 1.8 | 15.0 ± 5.8 | 3.0 ± 0.8 | 27.8 ± 4.6 |
| unequal-workload | shared | WRR | 7.9 ± 1.1 | 6.7 ± 1.7 | 6.5 ± 1.8 | 5.6 ± 1.5 | 14.8 ± 5.5 | 4.5 ± 1.8 | 27.7 ± 4.5 |
| long-waits | service | WPS | 20.8 ± 4.1 | 30.1 ± 8.8 | 53.2 ± 11.8 | 37.8 ± 14.1 | 284.9 ± 34.6 | 12.5 ± 2.2 | 322.2 ± 28.3 |
| long-waits | service | WPS-A | 21.5 ± 4.2 | 26.0 ± 6.5 | 53.2 ± 11.8 | 50.8 ± 14.1 | 284.9 ± 34.6 | 13.5 ± 2.2 | 322.2 ± 28.3 |
| long-waits | service | WRR | 35.7 ± 6.5 | 28.6 ± 5.9 | 65.3 ± 13.1 | 28.7 ± 6.4 | 284.0 ± 34.8 | 38.2 ± 6.7 | 317.2 ± 31.2 |
| long-waits | shared | WPS | 7.5 ± 0.8 | 11.3 ± 1.8 | 14.8 ± 2.0 | 16.0 ± 3.3 | 114.4 ± 17.0 | 5.3 ± 1.0 | 127.5 ± 16.5 |
| long-waits | shared | WPS-A | 7.8 ± 1.0 | 11.6 ± 1.7 | 15.0 ± 1.9 | 21.6 ± 2.1 | 113.2 ± 17.2 | 5.3 ± 1.0 | 126.9 ± 16.6 |
| long-waits | shared | WRR | 14.3 ± 1.4 | 13.0 ± 2.1 | 17.2 ± 2.6 | 12.0 ± 1.8 | 113.7 ± 16.9 | 11.3 ± 2.2 | 126.3 ± 16.3 |

## Throughput and doctor utilization

| Scenario | Dispatch | Policy | Patients | Throughput /h | Day length (min) | Util. Doctor 1 | Util. Doctor 2 | Util. Doctor 3 |
|---|---|---|---|---|---|---|---|---|
| low-volume | service | WPS | 64.7 ± 2.5 | 7.88 ± 0.27 | 492 ± 6 | 0.59 ± 0.04 | 0.33 ± 0.04 | 0.35 ± 0.03 |
| low-volume | service | WPS-A | 64.7 ± 2.5 | 7.88 ± 0.27 | 492 ± 6 | 0.59 ± 0.04 | 0.33 ± 0.04 | 0.35 ± 0.03 |
| low-volume | service | WRR | 64.7 ± 2.5 | 7.88 ± 0.27 | 492 ± 6 | 0.59 ± 0.04 | 0.33 ± 0.04 | 0.35 ± 0.03 |
| low-volume | shared | WPS | 64.7 ± 2.5 | 8.00 ± 0.30 | 485 ± 3 | 0.60 ± 0.02 | 0.42 ± 0.02 | 0.28 ± 0.02 |
| low-volume | shared | WPS-A | 64.7 ± 2.5 | 8.00 ± 0.30 | 485 ± 3 | 0.60 ± 0.02 | 0.42 ± 0.02 | 0.28 ± 0.02 |
| low-volume | shared | WRR | 64.7 ± 2.5 | 8.00 ± 0.30 | 485 ± 3 | 0.60 ± 0.02 | 0.43 ± 0.03 | 0.27 ± 0.02 |
| medium-volume | service | WPS | 109.3 ± 4.0 | 12.05 ± 0.32 | 547 ± 23 | 0.92 ± 0.02 | 0.51 ± 0.05 | 0.50 ± 0.04 |
| medium-volume | service | WPS-A | 109.3 ± 4.0 | 12.05 ± 0.32 | 547 ± 23 | 0.92 ± 0.02 | 0.51 ± 0.05 | 0.50 ± 0.04 |
| medium-volume | service | WRR | 109.3 ± 4.0 | 12.05 ± 0.32 | 547 ± 23 | 0.92 ± 0.02 | 0.51 ± 0.05 | 0.50 ± 0.04 |
| medium-volume | shared | WPS | 109.3 ± 4.0 | 13.45 ± 0.45 | 487 ± 4 | 0.80 ± 0.02 | 0.73 ± 0.03 | 0.63 ± 0.04 |
| medium-volume | shared | WPS-A | 109.3 ± 4.0 | 13.45 ± 0.45 | 487 ± 4 | 0.80 ± 0.02 | 0.73 ± 0.03 | 0.63 ± 0.04 |
| medium-volume | shared | WRR | 109.3 ± 4.0 | 13.44 ± 0.44 | 488 ± 4 | 0.80 ± 0.02 | 0.73 ± 0.03 | 0.63 ± 0.04 |
| high-volume | service | WPS | 149.2 ± 4.7 | 12.84 ± 0.36 | 702 ± 33 | 0.98 ± 0.01 | 0.54 ± 0.04 | 0.55 ± 0.04 |
| high-volume | service | WPS-A | 149.2 ± 4.7 | 12.84 ± 0.36 | 702 ± 33 | 0.98 ± 0.01 | 0.54 ± 0.04 | 0.55 ± 0.04 |
| high-volume | service | WRR | 149.2 ± 4.7 | 12.84 ± 0.36 | 702 ± 33 | 0.98 ± 0.01 | 0.54 ± 0.04 | 0.55 ± 0.04 |
| high-volume | shared | WPS | 149.2 ± 4.7 | 17.08 ± 0.29 | 524 ± 11 | 0.94 ± 0.01 | 0.92 ± 0.02 | 0.90 ± 0.02 |
| high-volume | shared | WPS-A | 149.2 ± 4.7 | 17.09 ± 0.29 | 523 ± 11 | 0.94 ± 0.01 | 0.93 ± 0.02 | 0.90 ± 0.02 |
| high-volume | shared | WRR | 149.2 ± 4.7 | 17.09 ± 0.29 | 523 ± 11 | 0.95 ± 0.01 | 0.92 ± 0.02 | 0.90 ± 0.02 |
| priority-surge | service | WPS | 102.4 ± 3.5 | 11.65 ± 0.28 | 529 ± 18 | 0.88 ± 0.03 | 0.49 ± 0.05 | 0.50 ± 0.04 |
| priority-surge | service | WPS-A | 102.4 ± 3.5 | 11.65 ± 0.28 | 529 ± 18 | 0.88 ± 0.03 | 0.49 ± 0.05 | 0.50 ± 0.04 |
| priority-surge | service | WRR | 102.4 ± 3.5 | 11.65 ± 0.28 | 529 ± 18 | 0.88 ± 0.03 | 0.49 ± 0.05 | 0.50 ± 0.04 |
| priority-surge | shared | WPS | 102.4 ± 3.5 | 12.60 ± 0.40 | 488 ± 2 | 0.77 ± 0.02 | 0.68 ± 0.03 | 0.57 ± 0.04 |
| priority-surge | shared | WPS-A | 102.4 ± 3.5 | 12.60 ± 0.40 | 488 ± 2 | 0.77 ± 0.02 | 0.68 ± 0.03 | 0.57 ± 0.04 |
| priority-surge | shared | WRR | 102.4 ± 3.5 | 12.60 ± 0.40 | 488 ± 2 | 0.77 ± 0.02 | 0.68 ± 0.03 | 0.57 ± 0.04 |
| unequal-workload | service | WPS | 116.8 ± 4.0 | 9.46 ± 0.25 | 745 ± 36 | 0.99 ± 0.00 | 0.26 ± 0.03 | 0.20 ± 0.02 |
| unequal-workload | service | WPS-A | 116.8 ± 4.0 | 9.46 ± 0.25 | 745 ± 36 | 0.99 ± 0.00 | 0.26 ± 0.03 | 0.20 ± 0.02 |
| unequal-workload | service | WRR | 116.8 ± 4.0 | 9.46 ± 0.25 | 745 ± 36 | 0.99 ± 0.00 | 0.26 ± 0.03 | 0.20 ± 0.02 |
| unequal-workload | shared | WPS | 116.8 ± 4.0 | 14.27 ± 0.46 | 491 ± 4 | 0.80 ± 0.02 | 0.74 ± 0.03 | 0.64 ± 0.04 |
| unequal-workload | shared | WPS-A | 116.8 ± 4.0 | 14.27 ± 0.46 | 491 ± 4 | 0.80 ± 0.02 | 0.74 ± 0.03 | 0.64 ± 0.04 |
| unequal-workload | shared | WRR | 116.8 ± 4.0 | 14.27 ± 0.47 | 491 ± 4 | 0.80 ± 0.02 | 0.74 ± 0.03 | 0.64 ± 0.04 |
| long-waits | service | WPS | 157.1 ± 4.3 | 12.92 ± 0.37 | 736 ± 33 | 0.99 ± 0.00 | 0.54 ± 0.03 | 0.55 ± 0.04 |
| long-waits | service | WPS-A | 157.1 ± 4.3 | 12.92 ± 0.37 | 736 ± 33 | 0.99 ± 0.00 | 0.54 ± 0.03 | 0.55 ± 0.04 |
| long-waits | service | WRR | 157.1 ± 4.3 | 12.92 ± 0.37 | 736 ± 33 | 0.99 ± 0.00 | 0.54 ± 0.03 | 0.55 ± 0.04 |
| long-waits | shared | WPS | 157.1 ± 4.3 | 17.86 ± 0.21 | 528 ± 13 | 0.97 ± 0.01 | 0.96 ± 0.01 | 0.95 ± 0.02 |
| long-waits | shared | WPS-A | 157.1 ± 4.3 | 17.86 ± 0.21 | 528 ± 13 | 0.97 ± 0.01 | 0.96 ± 0.01 | 0.95 ± 0.02 |
| long-waits | shared | WRR | 157.1 ± 4.3 | 17.86 ± 0.21 | 528 ± 13 | 0.97 ± 0.01 | 0.96 ± 0.01 | 0.95 ± 0.02 |

## Protected-priority ordering (decisions per day)

| Scenario | Dispatch | Policy | Lower score served while higher waited | Regular served while Senior/PWD/Pregnant waited | Jain fairness |
|---|---|---|---|---|---|
| low-volume | service | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.265 ± 0.020 |
| low-volume | service | WPS-A | 0.1 ± 0.1 | 0.0 ± 0.0 | 0.266 ± 0.020 |
| low-volume | service | WRR | 1.0 ± 0.6 | 0.4 ± 0.2 | 0.268 ± 0.020 |
| low-volume | shared | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.101 ± 0.017 |
| low-volume | shared | WPS-A | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.101 ± 0.017 |
| low-volume | shared | WRR | 0.4 ± 0.3 | 0.2 ± 0.2 | 0.103 ± 0.019 |
| medium-volume | service | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.368 ± 0.020 |
| medium-volume | service | WPS-A | 0.9 ± 0.4 | 0.0 ± 0.0 | 0.369 ± 0.020 |
| medium-volume | service | WRR | 2.9 ± 0.9 | 1.6 ± 0.6 | 0.379 ± 0.020 |
| medium-volume | shared | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.266 ± 0.028 |
| medium-volume | shared | WPS-A | 0.2 ± 0.3 | 0.0 ± 0.0 | 0.266 ± 0.028 |
| medium-volume | shared | WRR | 2.8 ± 0.8 | 1.9 ± 0.5 | 0.275 ± 0.028 |
| high-volume | service | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.382 ± 0.016 |
| high-volume | service | WPS-A | 2.8 ± 0.6 | 0.0 ± 0.0 | 0.384 ± 0.016 |
| high-volume | service | WRR | 8.2 ± 1.4 | 4.7 ± 0.8 | 0.394 ± 0.018 |
| high-volume | shared | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.425 ± 0.034 |
| high-volume | shared | WPS-A | 5.0 ± 1.8 | 0.0 ± 0.0 | 0.430 ± 0.034 |
| high-volume | shared | WRR | 8.7 ± 1.5 | 5.4 ± 0.8 | 0.433 ± 0.033 |
| priority-surge | service | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.271 ± 0.024 |
| priority-surge | service | WPS-A | 1.2 ± 0.4 | 0.0 ± 0.0 | 0.275 ± 0.024 |
| priority-surge | service | WRR | 10.5 ± 2.2 | 5.2 ± 0.8 | 0.353 ± 0.020 |
| priority-surge | shared | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.216 ± 0.018 |
| priority-surge | shared | WPS-A | 0.2 ± 0.2 | 0.0 ± 0.0 | 0.216 ± 0.017 |
| priority-surge | shared | WRR | 5.9 ± 1.5 | 2.8 ± 0.6 | 0.242 ± 0.019 |
| unequal-workload | service | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.436 ± 0.014 |
| unequal-workload | service | WPS-A | 2.0 ± 0.6 | 0.0 ± 0.0 | 0.437 ± 0.014 |
| unequal-workload | service | WRR | 6.5 ± 1.5 | 3.1 ± 0.6 | 0.441 ± 0.015 |
| unequal-workload | shared | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.260 ± 0.026 |
| unequal-workload | shared | WPS-A | 0.4 ± 0.4 | 0.0 ± 0.0 | 0.261 ± 0.026 |
| unequal-workload | shared | WRR | 2.7 ± 0.7 | 1.7 ± 0.5 | 0.265 ± 0.026 |
| long-waits | service | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.408 ± 0.017 |
| long-waits | service | WPS-A | 4.4 ± 0.8 | 0.0 ± 0.0 | 0.410 ± 0.018 |
| long-waits | service | WRR | 10.4 ± 1.5 | 5.7 ± 0.8 | 0.416 ± 0.019 |
| long-waits | shared | WPS | 0.0 ± 0.0 | 0.0 ± 0.0 | 0.503 ± 0.028 |
| long-waits | shared | WPS-A | 7.7 ± 1.6 | 0.0 ± 0.0 | 0.508 ± 0.028 |
| long-waits | shared | WRR | 11.4 ± 1.7 | 6.2 ± 0.8 | 0.510 ± 0.028 |
