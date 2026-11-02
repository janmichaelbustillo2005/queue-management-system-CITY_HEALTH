# Head to head: WRR versus WPS-A

Per-seed difference WRR − WPS-A on the same 30 synthetic days per scenario (mean ± 95% CI). Negative = WRR lower.
"WRR lower / higher" counts the days on which WRR's value was lower / higher than WPS-A's.

## Decision rule

1. **Priority-lane compliance (must pass):** on no simulated day may a Regular patient be called while a Senior, PWD or
   pregnant patient is waiting.
2. **Then** prefer the compliant policy with the shorter P95 and maximum waits, especially for Regular patients.

| Dispatch | Policy | Days with zero violations | Passes rule 1 |
|---|---|---|---|
| service | WPS | 180 of 180 | yes |
| service | WPS-A | 180 of 180 | yes |
| service | WRR | 31 of 180 | **no** |
| shared | WPS | 180 of 180 | yes |
| shared | WPS-A | 180 of 180 | yes |
| shared | WRR | 36 of 180 | **no** |

## Service dispatch (legacy: fixed doctor per service)

| Scenario | Average wait (min) | P95 wait (min) | Maximum wait (min) | Longest Regular wait (min) | Longest Senior/PWD/Pregnant wait (min) | Regular called while Senior/PWD/Pregnant waited (per day) |
|---|---|---|---|---|---|---|
| low-volume | 0.0 ± 0.0 <small>(9/5)</small> | 0.0 ± 0.8 <small>(7/3)</small> | -0.5 ± 1.3 <small>(4/1)</small> | -1.5 ± 1.7 <small>(5/1)</small> | 2.9 ± 2.4 <small>(0/7)</small> | 0.4 ± 0.2 <small>(0/9)</small> |
| medium-volume | 0.0 ± 0.1 <small>(8/18)</small> | -0.2 ± 1.1 <small>(8/3)</small> | -7.2 ± 6.2 <small>(6/0)</small> | -5.8 ± 5.9 <small>(5/0)</small> | 4.7 ± 3.6 <small>(2/12)</small> | 1.6 ± 0.6 <small>(0/22)</small> |
| high-volume | 0.2 ± 0.1 <small>(9/21)</small> | -0.3 ± 0.5 <small>(5/1)</small> | -5.8 ± 6.8 <small>(3/1)</small> | -6.3 ± 7.3 <small>(4/1)</small> | 14.6 ± 5.2 <small>(1/27)</small> | 4.7 ± 0.8 <small>(0/29)</small> |
| priority-surge | 0.1 ± 0.5 <small>(12/18)</small> | -22.0 ± 8.2 <small>(27/3)</small> | -38.2 ± 10.8 <small>(28/0)</small> | -37.7 ± 11.0 <small>(28/0)</small> | -6.9 ± 11.7 <small>(14/14)</small> | 5.2 ± 0.8 <small>(0/30)</small> |
| unequal-workload | 0.0 ± 0.2 <small>(16/13)</small> | 0.0 ± 0.3 <small>(2/2)</small> | 0.3 ± 0.8 <small>(1/1)</small> | 0.3 ± 0.8 <small>(1/1)</small> | 8.4 ± 4.5 <small>(5/20)</small> | 3.1 ± 0.6 <small>(0/29)</small> |
| long-waits | 0.1 ± 0.2 <small>(12/18)</small> | -0.5 ± 0.8 <small>(5/2)</small> | -4.5 ± 5.8 <small>(3/0)</small> | -5.0 ± 6.6 <small>(3/0)</small> | 15.1 ± 8.4 <small>(2/26)</small> | 5.7 ± 0.8 <small>(0/30)</small> |

## Shared queue (D1 Model A: three general doctors)

| Scenario | Average wait (min) | P95 wait (min) | Maximum wait (min) | Longest Regular wait (min) | Longest Senior/PWD/Pregnant wait (min) | Regular called while Senior/PWD/Pregnant waited (per day) |
|---|---|---|---|---|---|---|
| low-volume | 0.0 ± 0.0 <small>(2/2)</small> | 0.0 ± 0.1 <small>(3/2)</small> | -0.3 ± 0.3 <small>(5/0)</small> | -0.4 ± 0.4 <small>(5/0)</small> | 0.2 ± 0.3 <small>(1/3)</small> | 0.2 ± 0.2 <small>(0/6)</small> |
| medium-volume | 0.0 ± 0.0 <small>(16/9)</small> | -0.5 ± 0.5 <small>(16/7)</small> | -0.9 ± 0.6 <small>(14/6)</small> | -1.3 ± 0.8 <small>(14/5)</small> | 2.7 ± 1.2 <small>(1/18)</small> | 1.9 ± 0.5 <small>(0/24)</small> |
| high-volume | 0.0 ± 0.1 <small>(17/13)</small> | 0.0 ± 0.6 <small>(19/11)</small> | -0.3 ± 1.1 <small>(16/13)</small> | -0.5 ± 1.2 <small>(18/12)</small> | 3.9 ± 1.6 <small>(3/24)</small> | 5.4 ± 0.8 <small>(0/30)</small> |
| priority-surge | 0.0 ± 0.1 <small>(17/12)</small> | -0.3 ± 0.7 <small>(19/9)</small> | -4.1 ± 1.8 <small>(21/3)</small> | -4.6 ± 2.1 <small>(21/3)</small> | 1.5 ± 1.8 <small>(8/17)</small> | 2.8 ± 0.6 <small>(0/29)</small> |
| unequal-workload | 0.0 ± 0.0 <small>(11/16)</small> | 0.0 ± 0.4 <small>(14/10)</small> | -0.2 ± 0.8 <small>(11/7)</small> | -0.2 ± 0.7 <small>(12/6)</small> | 1.1 ± 0.8 <small>(3/15)</small> | 1.7 ± 0.5 <small>(0/25)</small> |
| long-waits | 0.0 ± 0.1 <small>(17/13)</small> | -0.5 ± 0.6 <small>(18/12)</small> | -0.5 ± 1.2 <small>(13/17)</small> | -0.6 ± 1.2 <small>(15/15)</small> | 4.0 ± 1.7 <small>(5/24)</small> | 6.2 ± 0.8 <small>(0/30)</small> |
