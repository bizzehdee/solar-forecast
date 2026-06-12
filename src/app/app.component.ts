import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Chart } from 'chart.js/auto';
import {
  BatteryPlanRow,
  DayForecast,
  ForecastConfig,
  ForecastPayload,
  ForecastService,
} from './forecast.service';

interface CachedForecastPayload {
  expiresAt: number;
  payload: ForecastPayload;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, AfterViewInit {
  private readonly storageKey = 'solar_forecast_dashboard_config_v1';
  private readonly payloadCacheKey = 'solar_forecast_dashboard_payload_v1';
  private readonly payloadCacheTtlMs = 10 * 60 * 1000;

  @ViewChild('summaryCanvas')
  summaryCanvas?: ElementRef<HTMLCanvasElement>;

  @ViewChildren('dayCanvas')
  dayCanvases?: QueryList<ElementRef<HTMLCanvasElement>>;

  config: ForecastConfig;
  payload: ForecastPayload | null = null;
  statusText = '';

  private summaryChart: Chart | null = null;
  private dayCharts: Chart[] = [];
  private viewReady = false;

  constructor(
    private readonly forecastService: ForecastService,
    private readonly cdr: ChangeDetectorRef,
  ) {
    this.config = this.forecastService.getDefaultConfig();
  }

  ngOnInit(): void {
    const saved = this.loadSavedConfig();
    if (saved) {
      this.config = this.forecastService.normalizeConfig(saved);
    }
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.refresh().catch(() => undefined);
  }

  async refresh(): Promise<void> {
    this.saveConfig(this.config);
    this.config = this.forecastService.normalizeConfig(this.config);

    const cachedPayload = this.loadCachedPayload(this.config);
    if (cachedPayload) {
      this.payload = cachedPayload;
      this.statusText = `Loaded cached forecast. Days loaded: ${cachedPayload.days.length}`;

      this.cdr.detectChanges();
      this.renderCharts();
      return;
    }

    this.statusText = 'Fetching latest forecast...';
    try {
      const payload = await this.forecastService.buildForecastPayload(this.config);
      this.payload = payload;
      this.saveCachedPayload(payload);
      this.statusText = `Updated. Days loaded: ${payload.days.length}`;

      this.cdr.detectChanges();
      this.renderCharts();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusText = `Failed to update: ${message}`;
    }
  }

  get assumptionsText(): string {
    if (!this.payload || !this.hasBattery) {
      return '';
    }
    const assumptions = this.payload.battery_assumptions;
    const currentSocText = assumptions.current_soc_at_0600_percent === null
      ? 'not provided'
      : `${Number(assumptions.current_soc_at_0600_percent).toFixed(1)}%`;

    return `Assumptions: ${assumptions.capacity_kwh} kWh battery, ${assumptions.reserve_percent_floor}% reserve floor, `
      + `${assumptions.assumed_daily_usage_kwh} kWh/day usage, planning window ${assumptions.planning_window}, `
      + `${assumptions.night_load_kwh_per_hour} kWh/hour during off-peak ${assumptions.off_peak_window}, `
      + `${assumptions.soc_rounding_step_percent}% SoC rounding step, current day SoC at ${assumptions.off_peak_end_label} ${currentSocText}, `
      + `strategy ${assumptions.strategy}, off-peak ${assumptions.off_peak_cost_p_per_kwh.toFixed(2)}p/kWh, `
      + `on-peak ${assumptions.on_peak_cost_p_per_kwh.toFixed(2)}p/kWh, `
      + `sell-back ${assumptions.sell_back_price_p_per_kwh.toFixed(2)}p/kWh.`;
  }

  get hasBattery(): boolean {
    return this.config.battery_capacity_kwh > 0;
  }

  get offPeakWindowLabel(): string {
    return `${this.config.off_peak_window_start}-${this.config.off_peak_window_end}`;
  }

  get offPeakEndLabel(): string {
    return this.config.off_peak_window_end;
  }

  trackDay(_: number, day: DayForecast): string {
    return day.date;
  }

  trackPlanRow(_: number, row: BatteryPlanRow): string {
    return row.date;
  }

  formatNetPence(value: number): string {
    return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
  }

  private saveConfig(config: ForecastConfig): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(config));
    } catch {
      // no-op if storage unavailable
    }
  }

  private loadSavedConfig(): Partial<Record<keyof ForecastConfig, unknown>> | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Partial<Record<keyof ForecastConfig, unknown>>;
      }
      return null;
    } catch {
      return null;
    }
  }

  private saveCachedPayload(payload: ForecastPayload): void {
    try {
      const cachedPayload: CachedForecastPayload = {
        expiresAt: Date.now() + this.payloadCacheTtlMs,
        payload,
      };
      localStorage.setItem(this.payloadCacheKey, JSON.stringify(cachedPayload));
    } catch {
      // no-op if storage unavailable
    }
  }

  private loadCachedPayload(config: ForecastConfig): ForecastPayload | null {
    try {
      const raw = localStorage.getItem(this.payloadCacheKey);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as CachedForecastPayload | null;
      if (!parsed || typeof parsed !== 'object') {
        this.clearCachedPayload();
        return null;
      }

      if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now()) {
        this.clearCachedPayload();
        return null;
      }

      const payload = parsed.payload;
      if (!payload || typeof payload !== 'object' || !payload.config) {
        this.clearCachedPayload();
        return null;
      }

      const normalizedCachedConfig = this.forecastService.normalizeConfig(payload.config);
      const normalizedRequestedConfig = this.forecastService.normalizeConfig(config);
      if (JSON.stringify(normalizedCachedConfig) !== JSON.stringify(normalizedRequestedConfig)) {
        return null;
      }

      return payload;
    } catch {
      this.clearCachedPayload();
      return null;
    }
  }

  private clearCachedPayload(): void {
    try {
      localStorage.removeItem(this.payloadCacheKey);
    } catch {
      // no-op if storage unavailable
    }
  }

  private renderCharts(): void {
    if (!this.viewReady || !this.payload) {
      return;
    }
    this.renderSummaryChart();
    this.renderDayCharts();
  }

  private renderSummaryChart(): void {
    if (!this.payload || !this.summaryCanvas) {
      return;
    }
    if (this.summaryChart) {
      this.summaryChart.destroy();
    }

    this.summaryChart = new Chart(this.summaryCanvas.nativeElement.getContext('2d')!, {
      type: 'bar',
      data: {
        labels: this.payload.summary.labels,
        datasets: [
          {
            label: 'Controller output total (kWh)',
            data: this.payload.summary.controller_output_kwh_total_by_day,
            backgroundColor: '#ca8a04',
          },
        ],
      },
      options: {
        responsive: true,
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'kWh' },
          },
        },
      },
    });
  }

  private renderDayCharts(): void {
    if (!this.payload || !this.dayCanvases) {
      return;
    }
    this.dayCharts.forEach((chart) => chart.destroy());
    this.dayCharts = [];

    const days = this.payload.days;
    const globalMaxW = days.reduce(
      (maxValue, day) => Math.max(maxValue, ...day.controller_output_power_w, 0),
      0,
    );
    const sharedYAxisMax = Math.max(100, Math.ceil(globalMaxW / 100) * 100);

    const canvases = this.dayCanvases.toArray();
    days.forEach((day, index) => {
      const canvas = canvases[index]?.nativeElement;
      if (!canvas) {
        return;
      }

      const chart = new Chart(canvas.getContext('2d')!, {
        type: 'line',
        data: {
          labels: day.times,
          datasets: [
            {
              label: 'Controller output (W)',
              data: day.controller_output_power_w,
              borderColor: '#facc15',
              backgroundColor: 'rgba(250,204,21,0.2)',
              tension: 0.25,
              pointRadius: 1.5,
              yAxisID: 'yPower',
            },
            {
              label: 'Cloud cover (%)',
              data: day.cloud_cover_percent,
              borderColor: '#9ca3af',
              backgroundColor: 'rgba(156,163,175,0.2)',
              tension: 0.25,
              pointRadius: 1.5,
              yAxisID: 'yCloud',
            },
          ],
        },
        options: {
          responsive: true,
          scales: {
            yPower: { beginAtZero: true, max: sharedYAxisMax, position: 'left' },
            yCloud: {
              beginAtZero: true,
              min: 0,
              max: 100,
              position: 'right',
              grid: { drawOnChartArea: false },
            },
          },
        },
      });
      this.dayCharts.push(chart);
    });
  }
}
