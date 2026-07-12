# 태양 흑점 차등회전 분석 프로젝트

Helioviewer 화면(2026-05-29)의 활성영역 11개(14443·14444·14445·14446·14447·14448·14449·14452·14453·14454·14455)를 포함해, NASA HEK API에서
2026-03-29 ~ 2026-07-29 (기준일 ±2개월) 활성영역 위치를 수집하고 위도별 회전 각속도
(차등회전)를 측정한 프로젝트입니다.

## 결과 요약

- 항성 기준 차등회전 프로파일 (추적 신뢰도 가중, N=40):
  **Ω(φ) = 14.50 − 4.81·sin²φ  [°/일]**
- 적도 회전주기 ≈ 24.8일(항성). 문헌값(Snodgrass & Ulrich 1990: 14.71 − 2.39sin²φ − 1.78sin⁴φ)과 부합.
- 독립적인 Stonyhurst 경도법과 0.1–0.4°/일 이내로 교차검증됨.

## 웹 대시보드 실행

`index.html`을 더블클릭하면 바로 동작합니다 — 4개월치 데이터가 파일에 내장되어 있어
서버가 필요 없습니다. 상단 **기간** 필터(시작일~종료일, 데이터 범위 내 선택)로 원하는
구간만 잘라 분석할 수 있고, 품질 필터와 함께 모든 그래프·표·통계가 동시에 갱신됩니다.

`serve.py`는 선택 사항입니다(로컬 HTTP 서버로 열고 싶을 때: `python3 serve.py` →
http://localhost:8899).

## 파일 구성

| 파일 | 내용 |
|---|---|
| `index.html` | 인터랙티브 대시보드 (단일 파일, 데이터 내장, 기간·품질 필터) |
| `serve.py` | (선택) 로컬 HTTP 서버 — 표준 라이브러리만 사용 |
| `differential_rotation.png` | seaborn 차등회전 그래프 |
| `흑점_차등회전_데이터.xlsx` | 데이터 정리 워크북 (방법론·일별위치·회전각속도) |
| `data/ar_daily_positions.csv` | AR별 일별 위도/경도 (Stonyhurst·Carrington) |
| `data/ar_rotation_rates.csv` | AR별 회전 각속도 피팅 결과 |
| `data/hek_noaa.csv` | HEK 원본 검출 (NOAA 번호 보유분) |
| `scripts/fetch_hek.py` | HEK 수집 (주 단위 청크 + 재시도) |
| `scripts/analyze.py` | 회전율 계산 + 프로파일 피팅 + seaborn 그래프 |
| `scripts/build_xlsx.py` | 엑셀 워크북 생성 |
| `scripts/gen_embedded.py` | 대시보드용 임베드 데이터 생성 (소스 라벨 포함 원본 검출) |
| `site/` | 대시보드 소스 (index.html 템플릿, app.js, analysis.js, build.py) |

## 방법 (요약)

1. HEK에서 AR 검출 수집 (HMI SHARP + NOAA SWPC Observer), |Stonyhurst 경도| ≤ 60°만 사용
2. NOAA 번호·날짜별 중앙값 → 일별 위치
3. Carrington 경도 L_C(t) 선형피팅 → Ω_sid = 14.1844 + 기울기
4. 품질 필터(RMS ≤ 1°, ≥5일) 후 가중 최소제곱으로 Ω = A + B·sin²φ (+C·sin⁴φ) 피팅

파이썬 파이프라인과 대시보드 JS는 동일한 수치를 재현합니다 (검증 완료).


> 배포: https://sunspot-differential-rotation.vercel.app
