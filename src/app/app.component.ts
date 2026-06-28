import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
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
  SolarArray,
  StrategyComparison,
} from './forecast.service';

interface CachedForecastPayload {
  createdAt: number;
  expiresAt: number;
  payload: ForecastPayload;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly storageKey = 'solar_forecast_dashboard_config_v1';
  private readonly payloadCacheKey = 'solar_forecast_dashboard_payload_v1';
  private readonly payloadCacheTtlMs = 10 * 60 * 1000;
  private readonly progressTickMs = 5 * 60 * 1000;

  @ViewChild('summaryCanvas')
  summaryCanvas?: ElementRef<HTMLCanvasElement>;

  @ViewChild('modalCanvas')
  modalCanvas?: ElementRef<HTMLCanvasElement>;

  @ViewChildren('dayCanvas')
  dayCanvases?: QueryList<ElementRef<HTMLCanvasElement>>;

  readonly panelTypes: ReadonlyArray<{ label: string; value: string; temp_coeff_per_c: number | null; performance_ratio: number | null }> = [
    { label: 'ABC',        value: 'ABC',        temp_coeff_per_c: -0.0026, performance_ratio: 0.94 },
    { label: 'HJT',        value: 'HJT',        temp_coeff_per_c: -0.0027, performance_ratio: 0.93 },
    { label: 'TOPCon',     value: 'TOPCon',     temp_coeff_per_c: -0.0032, performance_ratio: 0.90 },
    { label: 'Mono PERC',  value: 'Mono PERC',  temp_coeff_per_c: -0.0040, performance_ratio: 0.85 },
    { label: 'Poly',       value: 'Poly',       temp_coeff_per_c: -0.0043, performance_ratio: 0.80 },
    { label: 'CIGS/Amorph', value: 'CIGS/Amorph', temp_coeff_per_c: -0.0030, performance_ratio: 0.80 },
    { label: 'Custom',     value: 'custom',     temp_coeff_per_c: null,    performance_ratio: null },
  ];

  config: ForecastConfig;
  payload: ForecastPayload | null = null;
  statusText = '';
  activeArrayIndex = 0;

  todayForecastKwh = 0;
  todayGeneratedKwh = 0;
  todayProgressPercent = 0;

  modalDay: DayForecast | null = null;

  private summaryChart: Chart | null = null;
  private dayCharts: Chart[] = [];
  private modalChart: Chart | null = null;
  private sharedYAxisMax = 100;
  private viewReady = false;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

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

    // Keep the progress bar advancing through the day independently of when
    // (or whether) the forecast data is refreshed.
    this.progressTimer = setInterval(() => {
      this.updateTodayProgress();
      this.cdr.detectChanges();
    }, this.progressTickMs);
  }

  ngOnDestroy(): void {
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  async refresh(): Promise<void> {
    this.saveConfig(this.config);
    this.config = this.forecastService.normalizeConfig(this.config as unknown as Record<string, unknown>);

    const cachedForecast = this.loadCachedPayload(this.config);
    if (cachedForecast) {
      this.payload = this.forecastService.rebuildForecastPayload(this.config, cachedForecast.payload);
      this.statusText = `Loaded cached forecast from ${this.formatCacheAge(cachedForecast.createdAt)} ago. Days loaded: ${this.payload.days.length}`;

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

  isCustomPanelAt(index: number): boolean {
    return this.config.arrays[index]?.panel_type === 'custom';
  }

  onPanelTypeChange(index: number): void {
    const array = this.config.arrays[index];
    if (!array) return;
    const preset = this.panelTypes.find((p) => p.value === array.panel_type);
    if (preset && preset.temp_coeff_per_c !== null && preset.performance_ratio !== null) {
      array.temp_coeff_per_c = preset.temp_coeff_per_c;
      array.performance_ratio = preset.performance_ratio;
    }
  }

  addArray(): void {
    const last = this.config.arrays[this.config.arrays.length - 1];
    const clone: SolarArray = structuredClone(last ?? this.forecastService.getDefaultArray());
    clone.label = '';
    this.config.arrays.push(clone);
    this.activeArrayIndex = this.config.arrays.length - 1;
  }

  removeArray(index: number): void {
    if (this.config.arrays.length > 1) {
      this.config.arrays.splice(index, 1);
      if (this.activeArrayIndex >= this.config.arrays.length) {
        this.activeArrayIndex = this.config.arrays.length - 1;
      }
    }
  }

  trackArray(index: number): number {
    return index;
  }

  trackDay(_: number, day: DayForecast): string {
    return day.date;
  }

  trackPlanRow(_: number, row: BatteryPlanRow): string {
    return row.date;
  }

  trackComparison(_: number, comparison: StrategyComparison): string {
    return comparison.strategy;
  }

  openModal(day: DayForecast): void {
    this.modalDay = day;
    this.cdr.detectChanges();
    setTimeout(() => this.renderModalChart(), 0);
  }

  closeModal(): void {
    if (this.modalChart) {
      this.modalChart.destroy();
      this.modalChart = null;
    }
    this.modalDay = null;
  }

  formatNetPence(value: number): string {
    return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
  }

  formatPounds(pence: number): string {
    const pounds = pence / 100;
    return pounds >= 0 ? `+£${pounds.toFixed(2)}` : `-£${Math.abs(pounds).toFixed(2)}`;
  }

  private saveConfig(config: ForecastConfig): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(config));
    } catch {
      // no-op if storage unavailable
    }
  }

  private loadSavedConfig(): Record<string, unknown> | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  private saveCachedPayload(payload: ForecastPayload): void {
    try {
      const now = Date.now();
      const cachedPayload: CachedForecastPayload = {
        createdAt: now,
        expiresAt: now + this.payloadCacheTtlMs,
        payload,
      };
      localStorage.setItem(this.payloadCacheKey, JSON.stringify(cachedPayload));
    } catch {
      // no-op if storage unavailable
    }
  }

  private loadCachedPayload(config: ForecastConfig): CachedForecastPayload | null {
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

      if (!Number.isFinite(parsed.createdAt) || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now()) {
        this.clearCachedPayload();
        return null;
      }

      const payload = parsed.payload;
      if (!payload || typeof payload !== 'object' || !payload.config) {
        this.clearCachedPayload();
        return null;
      }

      if (!this.forecastService.isCacheReusableForConfig(payload.config, config)) {
        return null;
      }

      return parsed;
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

  private formatCacheAge(createdAt: number): string {
    const ageMs = Math.max(0, Date.now() - createdAt);
    const ageSeconds = Math.floor(ageMs / 1000);

    if (ageSeconds < 60) {
      return ageSeconds === 1 ? '1 second' : `${ageSeconds} seconds`;
    }

    const ageMinutes = Math.floor(ageSeconds / 60);
    if (ageMinutes < 60) {
      return ageMinutes === 1 ? '1 minute' : `${ageMinutes} minutes`;
    }

    const ageHours = Math.floor(ageMinutes / 60);
    return ageHours === 1 ? '1 hour' : `${ageHours} hours`;
  }

  private renderCharts(): void {
    if (!this.viewReady || !this.payload) {
      return;
    }
    this.updateTodayProgress();
    this.renderSummaryChart();
    this.renderDayCharts();
  }

  /**
   * Recompute how much of today's forecast solar has been produced so far,
   * based on the current local time of day. The hourly controller output
   * values are treated as Wh over each hour; the current hour is prorated by
   * how far into it we are. Runs both on refresh and on a 5-minute timer so
   * the bar keeps filling even if the forecast data is not refreshed.
   */
  private updateTodayProgress(): void {
    const today = this.findTodayForecast();
    if (!today) {
      this.todayForecastKwh = 0;
      this.todayGeneratedKwh = 0;
      this.todayProgressPercent = 0;
      return;
    }

    const now = new Date();
    const currentHourFloat = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;

    let generatedWh = 0;
    for (let i = 0; i < today.times.length; i += 1) {
      const hour = Number.parseInt(today.times[i].split(':', 1)[0], 10);
      const powerW = today.controller_output_power_w[i] ?? 0;
      if (!Number.isFinite(hour)) {
        continue;
      }
      if (currentHourFloat >= hour + 1) {
        generatedWh += powerW;
      } else if (currentHourFloat > hour) {
        generatedWh += powerW * (currentHourFloat - hour);
      }
    }

    const totalWh = today.controller_output_power_w_total;
    this.todayForecastKwh = totalWh / 1000;
    this.todayGeneratedKwh = generatedWh / 1000;
    this.todayProgressPercent = totalWh > 0
      ? Math.max(0, Math.min(100, (generatedWh / totalWh) * 100))
      : 0;
  }

  private findTodayForecast(): DayForecast | null {
    if (!this.payload || this.payload.days.length === 0) {
      return null;
    }
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return this.payload.days.find((day) => day.date === todayKey) ?? this.payload.days[0];
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

  private renderModalChart(): void {
    if (!this.modalDay || !this.modalCanvas) {
      return;
    }
    if (this.modalChart) {
      this.modalChart.destroy();
    }
    const day = this.modalDay;
    this.modalChart = new Chart(this.modalCanvas.nativeElement.getContext('2d')!, {
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
            pointRadius: 2,
            yAxisID: 'yPower',
          },
          {
            label: 'Cloud cover (%)',
            data: day.cloud_cover_percent,
            borderColor: '#9ca3af',
            backgroundColor: 'rgba(156,163,175,0.2)',
            tension: 0.25,
            pointRadius: 2,
            yAxisID: 'yCloud',
          },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          yPower: { beginAtZero: true, max: this.sharedYAxisMax, position: 'left' },
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
    this.sharedYAxisMax = sharedYAxisMax;

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
          interaction: { mode: 'index', intersect: false },
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
