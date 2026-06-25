import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

type Strategy = 'sell-all' | 'balanced' | 'zero-cost';

interface ForecastConfig {
  latitude: number;
  longitude: number;
  tilt: number;
  azimuth: number;
  installed_watts: number;
  performance_ratio: number;
  controller_efficiency: number;
  controller_max_output_watts: number | null;
  battery_capacity_kwh: number;
  assumed_daily_usage_kwh: number;
  reserve_percent_floor: number;
  night_load_kwh_per_hour: number;
  soc_rounding_step_percent: number;
  current_soc_at_0600_percent: number | null;
  strategy: Strategy;
  off_peak_cost_p_per_kwh: number;
  off_peak_window_start: string;
  off_peak_window_end: string;
  on_peak_cost_p_per_kwh: number;
  sell_back_price_p_per_kwh: number;
  timezone: string;
}

interface PanelModelConfig {
  temp_coeff_per_c: number;
  noct_c: number;
  low_light_gain: number;
  wind_cooling_c_per_m_s: number;
}

interface OpenMeteoResponse {
  hourly?: {
    time?: string[];
    global_tilted_irradiance?: Array<number | null>;
    temperature_2m?: Array<number | null>;
    wind_speed_10m?: Array<number | null>;
    cloud_cover?: Array<number | null>;
  };
}

interface DayForecast {
  date: string;
  times: string[];
  pv_dc_power_w: number[];
  controller_output_power_w: number[];
  cloud_cover_percent: number[];
  pv_dc_power_w_total: number;
  controller_output_power_w_total: number;
}

interface BatteryPlanRow {
  date: string;
  forecast_solar_kwh_day_total: number;
  recommended_target_percent_before_6am: number;
  recommended_target_energy_kwh: number;
  grid_charge_from_reserve_floor_kwh: number;
  grid_charge_0000_0600_recommendation: string;
  projected_end_of_day_soc_percent: number;
  daily_net_pence: number;
  assumed_daily_usage_kwh: number;
  reserve_floor_violated_even_at_full_charge: boolean;
  projected_soc_at_0600_without_grid_kwh?: number;
  actual_soc_at_0600_kwh?: number | null;
  off_peak_import_kwh?: number;
  on_peak_import_kwh?: number;
  solar_export_kwh?: number;
  daily_cost_off_peak_pence?: number;
  daily_cost_on_peak_pence?: number;
  daily_earnings_export_pence?: number;
  projected_end_of_day_soc_kwh?: number;
  projected_min_soc_percent?: number;
  projected_reserve_breach?: boolean;
}

interface BatteryAssumptions {
  capacity_kwh: number;
  reserve_percent_floor: number;
  assumed_daily_usage_kwh: number;
  night_load_kwh_per_hour: number;
  night_hours_to_target: number;
  soc_rounding_step_percent: number;
  current_soc_at_0600_percent: number | null;
  strategy: Strategy;
  off_peak_cost_p_per_kwh: number;
  off_peak_window: string;
  off_peak_end_label: string;
  on_peak_cost_p_per_kwh: number;
  sell_back_price_p_per_kwh: number;
  planning_window: string;
}

interface ForecastSummary {
  labels: string[];
  controller_output_kwh_total_by_day: number[];
  forecast_total_controller_output_kwh: number;
  forecast_total_pv_dc_kwh: number;
}

interface StrategyComparison {
  strategy: Strategy;
  label: string;
  total_off_peak_import_kwh: number;
  total_on_peak_import_kwh: number;
  total_solar_export_kwh: number;
  total_cost_off_peak_pence: number;
  total_cost_on_peak_pence: number;
  total_earnings_export_pence: number;
  total_net_pence: number;
}

interface StrategyRecommendation {
  recommended_strategy: Strategy;
  recommended_label: string;
  is_current_strategy: boolean;
  horizon_days: number;
  best: StrategyComparison;
  comparisons: StrategyComparison[];
  explanation: string;
}

interface StrategyPlanContext {
  capacityWh: number;
  reserveWh: number;
  currentDayStartSocWh: number | null;
  overnightDrainWh: number;
  daytimeLoadTotalWh: number;
  planningWindowStartHour: number;
  planningWindowEndHour: number;
}

export interface ForecastPayload {
  config: ForecastConfig;
  days: DayForecast[];
  summary: ForecastSummary;
  battery_plan: BatteryPlanRow[];
  battery_assumptions: BatteryAssumptions;
  strategy_recommendation: StrategyRecommendation | null;
}

@Injectable({
  providedIn: 'root',
})
export class ForecastService {
  private readonly forecastDays = 16;
  private readonly openMeteoUrl = 'https://api.open-meteo.com/v1/forecast';

  readonly defaultConfig: ForecastConfig = {
    latitude: 51.5074,
    longitude: -0.1278,
    tilt: 35.0,
    azimuth: 0.0,
    installed_watts: 5000.0,
    performance_ratio: 0.85,
    controller_efficiency: 0.98,
    controller_max_output_watts: null,
    battery_capacity_kwh: 16.0,
    assumed_daily_usage_kwh: 14.0,
    reserve_percent_floor: 10.0,
    night_load_kwh_per_hour: 0.3,
    soc_rounding_step_percent: 5.0,
    current_soc_at_0600_percent: null,
    strategy: 'zero-cost',
    off_peak_cost_p_per_kwh: 0.0,
    off_peak_window_start: '00:00',
    off_peak_window_end: '06:00',
    on_peak_cost_p_per_kwh: 0.0,
    sell_back_price_p_per_kwh: 0.0,
    timezone: 'auto',
  };

  private readonly panelModel: PanelModelConfig = {
    temp_coeff_per_c: -0.0026,
    noct_c: 44.0,
    low_light_gain: 0.04,
    wind_cooling_c_per_m_s: 0.6,
  };

  constructor(private readonly http: HttpClient) {}

  getDefaultConfig(): ForecastConfig {
    return structuredClone(this.defaultConfig);
  }

  normalizeConfig(rawConfig: Partial<Record<keyof ForecastConfig, unknown>>): ForecastConfig {
    const strategyInput = String(rawConfig.strategy ?? this.defaultConfig.strategy).trim().toLowerCase();
    const strategy: Strategy = ['sell-all', 'balanced', 'zero-cost'].includes(strategyInput)
      ? (strategyInput as Strategy)
      : this.defaultConfig.strategy;

    return {
      latitude: this.toNumberOrDefault(rawConfig.latitude, this.defaultConfig.latitude),
      longitude: this.toNumberOrDefault(rawConfig.longitude, this.defaultConfig.longitude),
      tilt: this.toNumberOrDefault(rawConfig.tilt, this.defaultConfig.tilt),
      azimuth: this.toNumberOrDefault(rawConfig.azimuth, this.defaultConfig.azimuth),
      installed_watts: this.toNumberOrDefault(rawConfig.installed_watts, this.defaultConfig.installed_watts),
      performance_ratio: this.toNumberOrDefault(rawConfig.performance_ratio, this.defaultConfig.performance_ratio),
      controller_efficiency: this.toNumberOrDefault(rawConfig.controller_efficiency, this.defaultConfig.controller_efficiency),
      controller_max_output_watts: this.toOptionalNumber(
        rawConfig.controller_max_output_watts,
        this.defaultConfig.controller_max_output_watts,
      ),
      battery_capacity_kwh: this.toNumberOrDefault(rawConfig.battery_capacity_kwh, this.defaultConfig.battery_capacity_kwh),
      assumed_daily_usage_kwh: this.toNumberOrDefault(rawConfig.assumed_daily_usage_kwh, this.defaultConfig.assumed_daily_usage_kwh),
      reserve_percent_floor: this.toBoundedNumber(
        rawConfig.reserve_percent_floor,
        this.defaultConfig.reserve_percent_floor,
        0.0,
        100.0,
      ),
      night_load_kwh_per_hour: this.toBoundedNumber(
        rawConfig.night_load_kwh_per_hour,
        this.defaultConfig.night_load_kwh_per_hour,
        0.0,
      ),
      soc_rounding_step_percent: this.toBoundedNumber(
        rawConfig.soc_rounding_step_percent,
        this.defaultConfig.soc_rounding_step_percent,
        0.1,
        100.0,
      ),
      current_soc_at_0600_percent: this.toOptionalNumber(
        rawConfig.current_soc_at_0600_percent,
        this.defaultConfig.current_soc_at_0600_percent,
      ),
      strategy,
      off_peak_cost_p_per_kwh: this.toNumberOrDefault(rawConfig.off_peak_cost_p_per_kwh, this.defaultConfig.off_peak_cost_p_per_kwh),
      off_peak_window_start: this.normalizeTimeValue(rawConfig.off_peak_window_start, this.defaultConfig.off_peak_window_start),
      off_peak_window_end: this.normalizeTimeValue(rawConfig.off_peak_window_end, this.defaultConfig.off_peak_window_end),
      on_peak_cost_p_per_kwh: this.toNumberOrDefault(rawConfig.on_peak_cost_p_per_kwh, this.defaultConfig.on_peak_cost_p_per_kwh),
      sell_back_price_p_per_kwh: this.toNumberOrDefault(rawConfig.sell_back_price_p_per_kwh, this.defaultConfig.sell_back_price_p_per_kwh),
      timezone: String(rawConfig.timezone ?? this.defaultConfig.timezone),
    };
  }

  async buildForecastPayload(config: ForecastConfig): Promise<ForecastPayload> {
    const normalizedConfig = this.normalizeConfig(config);
    const data = await this.fetchOpenMeteo(normalizedConfig);
    return this.buildPayload(normalizedConfig, data);
  }

  rebuildForecastPayload(config: ForecastConfig, cachedPayload: ForecastPayload): ForecastPayload {
    const normalizedConfig = this.normalizeConfig(config);
    const weatherCompatibleConfig = {
      ...normalizedConfig,
      installed_watts: cachedPayload.config.installed_watts,
      performance_ratio: cachedPayload.config.performance_ratio,
      controller_efficiency: cachedPayload.config.controller_efficiency,
      controller_max_output_watts: cachedPayload.config.controller_max_output_watts,
    };

    const weatherData = this.extractOpenMeteoResponse(cachedPayload);
    return this.buildPayload(weatherCompatibleConfig, weatherData);
  }

  isCacheReusableForConfig(cachedConfig: ForecastConfig, requestedConfig: ForecastConfig): boolean {
    const cached = this.normalizeConfig(cachedConfig);
    const requested = this.normalizeConfig(requestedConfig);

    return cached.latitude === requested.latitude
      && cached.longitude === requested.longitude
      && cached.tilt === requested.tilt
      && cached.azimuth === requested.azimuth
      && cached.installed_watts === requested.installed_watts
      && cached.performance_ratio === requested.performance_ratio
      && cached.controller_efficiency === requested.controller_efficiency
      && cached.controller_max_output_watts === requested.controller_max_output_watts
      && cached.timezone === requested.timezone;
  }

  private extractOpenMeteoResponse(payload: ForecastPayload): OpenMeteoResponse {
    const time: string[] = [];
    const global_tilted_irradiance: number[] = [];
    const temperature_2m: number[] = [];
    const wind_speed_10m: number[] = [];
    const cloud_cover: number[] = [];
    const config = this.normalizeConfig(payload.config);

    for (const day of payload.days) {
      for (let index = 0; index < day.times.length; index += 1) {
        const controllerOutputW = day.controller_output_power_w[index] ?? 0.0;
        const pvDcPowerW = day.pv_dc_power_w[index] ?? 0.0;
        const cloudCoverPercent = day.cloud_cover_percent[index] ?? 0.0;
        const irradianceRatio = config.installed_watts > 0 && config.performance_ratio > 0
          ? pvDcPowerW / (config.installed_watts * config.performance_ratio)
          : 0.0;

        time.push(`${day.date}T${day.times[index]}`);
        global_tilted_irradiance.push(Number(Math.max(0.0, irradianceRatio * 1000.0).toFixed(3)));
        temperature_2m.push(20.0);
        wind_speed_10m.push(0.0);
        cloud_cover.push(Number(cloudCoverPercent.toFixed(2)));

        if (config.controller_efficiency > 0 && config.controller_max_output_watts === null && controllerOutputW > 0 && pvDcPowerW <= 0) {
          global_tilted_irradiance[global_tilted_irradiance.length - 1] = Number(((controllerOutputW / config.controller_efficiency) / Math.max(config.installed_watts * config.performance_ratio, 1) * 1000.0).toFixed(3));
        }
      }
    }

    return {
      hourly: {
        time,
        global_tilted_irradiance,
        temperature_2m,
        wind_speed_10m,
        cloud_cover,
      },
    };
  }

  private toNumberOrDefault(value: unknown, fallback: number): number {
    if (value === null || value === undefined || String(value).trim() === '') {
      return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private toOptionalNumber(value: unknown, fallback: number | null): number | null {
    if (value === null || value === undefined || String(value).trim() === '') {
      return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private toBoundedNumber(value: unknown, fallback: number, min: number, max?: number): number {
    const parsed = this.toNumberOrDefault(value, fallback);
    if (max === undefined) {
      return Math.max(min, parsed);
    }
    return Math.min(max, Math.max(min, parsed));
  }

  private normalizeTimeValue(value: unknown, fallback: string): string {
    const text = String(value ?? '').trim();
    if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) {
      return text;
    }
    return fallback;
  }

  private timeToHour(value: string): number {
    const [hourText, minuteText] = value.split(':', 2);
    const hours = Number.parseInt(hourText, 10);
    const minutes = Number.parseInt(minuteText, 10);
    return hours + (minutes / 60);
  }

  private durationHours(startTime: string, endTime: string): number {
    const startHour = this.timeToHour(startTime);
    const endHour = this.timeToHour(endTime);
    const raw = endHour - startHour;
    return raw > 0 ? raw : raw + 24;
  }

  private async fetchOpenMeteo(config: ForecastConfig): Promise<OpenMeteoResponse> {
    const params = new URLSearchParams({
      latitude: String(config.latitude),
      longitude: String(config.longitude),
      hourly: 'global_tilted_irradiance,temperature_2m,wind_speed_10m,cloud_cover',
      tilt: String(config.tilt),
      azimuth: String(config.azimuth),
      wind_speed_unit: 'ms',
      timezone: config.timezone,
      forecast_days: String(this.forecastDays),
    });
    return firstValueFrom(this.http.get<OpenMeteoResponse>(`${this.openMeteoUrl}?${params.toString()}`));
  }

  private estimateAbcPowerW(gtiWm2: number, ambientTempC: number, windSpeedMs: number, config: ForecastConfig): number {
    const irradianceRatio = Math.max(gtiWm2, 0.0) / 1000.0;
    const moduleTempC = ambientTempC
      + ((this.panelModel.noct_c - 20.0) / 800.0) * Math.max(gtiWm2, 0.0)
      - (this.panelModel.wind_cooling_c_per_m_s * Math.max(windSpeedMs, 0.0));
    const tempFactor = Math.max(0.0, 1.0 + this.panelModel.temp_coeff_per_c * (moduleTempC - 25.0));
    let lowLightFactor = 1.0;
    if (gtiWm2 > 0.0) {
      lowLightFactor += Math.max(this.panelModel.low_light_gain, 0.0) * Math.max(0.0, 1.0 - irradianceRatio);
    }
    return Math.max(
      config.installed_watts * irradianceRatio * config.performance_ratio * tempFactor * lowLightFactor,
      0.0,
    );
  }

  private hourFromTimeLabel(label: string): number {
    return Number.parseInt(label.split(':', 1)[0], 10);
  }

  private simulateDaySoc(
    hourlySolarWh: number[],
    startSocWh: number,
    loadWhPerHour: number,
    capacityWh: number,
  ): { endSocWh: number; minSocWh: number } {
    let socWh = startSocWh;
    let minSocWh = startSocWh;
    for (const solarWh of hourlySolarWh) {
      socWh += solarWh - loadWhPerHour;
      if (socWh > capacityWh) {
        socWh = capacityWh;
      }
      if (socWh < minSocWh) {
        minSocWh = socWh;
      }
    }
    return { endSocWh: socWh, minSocWh };
  }

  private recommendGridTarget(
    day: DayForecast,
    batteryCapacityKwh: number,
    assumedDailyUsageKwh: number,
    reservePercentFloor: number,
    socRoundingStepPercent: number,
    planningWindowStartHour: number,
    planningWindowEndHour: number,
  ): BatteryPlanRow {
    const capacityWh = batteryCapacityKwh * 1000.0;
    const reserveWh = capacityWh * (reservePercentFloor / 100.0);
    const loadWhPerHour = (assumedDailyUsageKwh * 1000.0) / 24.0;
    const planningHours = day.times
      .map((timeLabel, idx) => ({ hour: this.hourFromTimeLabel(timeLabel), solarWh: day.controller_output_power_w[idx] }))
      .filter((item) => item.hour >= planningWindowStartHour && item.hour < planningWindowEndHour)
      .map((item) => item.solarWh);

    let targetSocWh: number | null = null;
    let reserveFloorViolated = true;
    for (let candidateSocWh = Math.floor(reserveWh); candidateSocWh <= Math.floor(capacityWh); candidateSocWh += 1) {
      const sim = this.simulateDaySoc(planningHours, candidateSocWh, loadWhPerHour, capacityWh);
      if (sim.minSocWh >= reserveWh) {
        targetSocWh = candidateSocWh;
        reserveFloorViolated = false;
        break;
      }
    }
    if (targetSocWh === null) {
      targetSocWh = capacityWh;
    }

    const targetPercent = (targetSocWh / capacityWh) * 100.0;
    const roundedTargetPercent = Math.min(
      100.0,
      Math.ceil(targetPercent / socRoundingStepPercent) * socRoundingStepPercent,
    );
    const roundedTargetSocWh = capacityWh * (roundedTargetPercent / 100.0);
    const gridChargeFromFloorKwh = Math.max(0.0, (roundedTargetSocWh - reserveWh) / 1000.0);

    return {
      date: day.date,
      forecast_solar_kwh_day_total: Number((day.controller_output_power_w_total / 1000.0).toFixed(3)),
      recommended_target_percent_before_6am: Number(roundedTargetPercent.toFixed(1)),
      recommended_target_energy_kwh: Number((roundedTargetSocWh / 1000.0).toFixed(3)),
      grid_charge_from_reserve_floor_kwh: Number(gridChargeFromFloorKwh.toFixed(3)),
      grid_charge_0000_0600_recommendation: 'Depends on current SoC',
      projected_end_of_day_soc_percent: 0,
      daily_net_pence: 0,
      assumed_daily_usage_kwh: assumedDailyUsageKwh,
      reserve_floor_violated_even_at_full_charge: reserveFloorViolated,
    };
  }

  private simulateDayStrategy(
    strategy: Strategy,
    hourlySolarWh: number[],
    startSocWh: number,
    loadWhPerHour: number,
    capacityWh: number,
    reserveWh: number,
  ): { end_soc_wh: number; min_soc_wh: number; solar_sold_wh: number; on_peak_import_wh: number } {
    let socWh = startSocWh;
    let minSocWh = socWh;
    let solarSoldWh = 0.0;
    let onPeakImportWh = 0.0;

    for (const solarWh of hourlySolarWh) {
      let loadRemainingWh = loadWhPerHour;
      let solarRemainingWh = Math.max(0.0, solarWh);

      if (strategy === 'zero-cost') {
        const solarToLoadWh = Math.min(solarRemainingWh, loadRemainingWh);
        loadRemainingWh -= solarToLoadWh;
        solarRemainingWh -= solarToLoadWh;

        const dischargeWh = Math.min(loadRemainingWh, Math.max(0.0, socWh - reserveWh));
        socWh -= dischargeWh;
        loadRemainingWh -= dischargeWh;
        onPeakImportWh += loadRemainingWh;

        const chargeWh = Math.min(solarRemainingWh, Math.max(0.0, capacityWh - socWh));
        socWh += chargeWh;
        solarRemainingWh -= chargeWh;
        solarSoldWh += solarRemainingWh;
      } else if (strategy === 'balanced') {
        const dischargeWh = Math.min(loadRemainingWh, Math.max(0.0, socWh - reserveWh));
        socWh -= dischargeWh;
        loadRemainingWh -= dischargeWh;
        onPeakImportWh += loadRemainingWh;

        const chargeWh = Math.min(solarRemainingWh, Math.max(0.0, capacityWh - socWh));
        socWh += chargeWh;
        solarRemainingWh -= chargeWh;
        solarSoldWh += solarRemainingWh;
      } else {
        const dischargeWh = Math.min(loadRemainingWh, Math.max(0.0, socWh - reserveWh));
        socWh -= dischargeWh;
        loadRemainingWh -= dischargeWh;
        onPeakImportWh += loadRemainingWh;
        solarSoldWh += solarRemainingWh;
      }

      if (socWh < minSocWh) {
        minSocWh = socWh;
      }
    }

    return {
      end_soc_wh: socWh,
      min_soc_wh: minSocWh,
      solar_sold_wh: solarSoldWh,
      on_peak_import_wh: onPeakImportWh,
    };
  }

  private buildPayload(config: ForecastConfig, data: OpenMeteoResponse): ForecastPayload {
    const hourly = data.hourly ?? {};
    const times = hourly.time ?? [];
    const irradiance = hourly.global_tilted_irradiance ?? [];
    const ambientTemps = hourly.temperature_2m ?? [];
    const windSpeeds = hourly.wind_speed_10m ?? [];
    const cloudCover = hourly.cloud_cover ?? [];

    const daily: Record<string, DayForecast> = {};
    let forecastTotalPv = 0.0;
    let forecastTotalController = 0.0;

    for (let i = 0; i < times.length; i += 1) {
      const timestamp = times[i];
      const gtiValue = Number.isFinite(Number(irradiance[i])) ? Number(irradiance[i]) : 0.0;
      const ambientTemp = Number.isFinite(Number(ambientTemps[i])) ? Number(ambientTemps[i]) : 20.0;
      const windSpeed = Number.isFinite(Number(windSpeeds[i])) ? Number(windSpeeds[i]) : 0.0;
      const cloud = Number.isFinite(Number(cloudCover[i])) ? Number(cloudCover[i]) : 0.0;

      const pvDcPowerW = this.estimateAbcPowerW(gtiValue, ambientTemp, windSpeed, config);
      let controllerOutputW = pvDcPowerW * config.controller_efficiency;
      if (config.controller_max_output_watts !== null && controllerOutputW > config.controller_max_output_watts) {
        controllerOutputW = config.controller_max_output_watts;
      }

      const [dayKey, timeKey = '00:00'] = String(timestamp).split('T', 2);
      if (!daily[dayKey]) {
        daily[dayKey] = {
          date: dayKey,
          times: [],
          pv_dc_power_w: [],
          controller_output_power_w: [],
          cloud_cover_percent: [],
          pv_dc_power_w_total: 0.0,
          controller_output_power_w_total: 0.0,
        };
      }

      daily[dayKey].times.push(timeKey);
      daily[dayKey].pv_dc_power_w.push(Number(pvDcPowerW.toFixed(3)));
      daily[dayKey].controller_output_power_w.push(Number(controllerOutputW.toFixed(3)));
      daily[dayKey].cloud_cover_percent.push(Number(cloud.toFixed(2)));
      daily[dayKey].pv_dc_power_w_total += pvDcPowerW;
      daily[dayKey].controller_output_power_w_total += controllerOutputW;
      forecastTotalPv += pvDcPowerW;
      forecastTotalController += controllerOutputW;
    }

    const days: DayForecast[] = [];
    const summaryLabels: string[] = [];
    const summaryValuesKwh: number[] = [];
    const baseTargetRows: BatteryPlanRow[] = [];
    const batteryCapacityKwh = Math.max(0.0, config.battery_capacity_kwh);
    const hasBattery = batteryCapacityKwh > 0;
    const assumedDailyUsageKwh = Math.max(0.0, config.assumed_daily_usage_kwh);
    const reservePercentFloor = config.reserve_percent_floor;
    const nightLoadKwhPerHour = config.night_load_kwh_per_hour;
    const socRoundingStepPercent = config.soc_rounding_step_percent;
    const offPeakWindowStart = config.off_peak_window_start;
    const offPeakWindowEnd = config.off_peak_window_end;
    const planningWindowStartHour = this.timeToHour(offPeakWindowEnd);
    const planningWindowEndHour = 24.0;
    const offPeakWindowDurationHours = this.durationHours(offPeakWindowStart, offPeakWindowEnd);
    const capacityWh = batteryCapacityKwh * 1000.0;
    const reserveWh = capacityWh * (reservePercentFloor / 100.0);
    const overnightDrainKwh = nightLoadKwhPerHour * offPeakWindowDurationHours;
    const overnightDrainWh = overnightDrainKwh * 1000.0;
    const daytimeLoadTotalWh = Math.max(0.0, (assumedDailyUsageKwh - overnightDrainKwh) * 1000.0);

    const sortedDayKeys = Object.keys(daily).sort();
    for (const dayKey of sortedDayKeys) {
      const item = daily[dayKey];
      item.pv_dc_power_w_total = Number(item.pv_dc_power_w_total.toFixed(3));
      item.controller_output_power_w_total = Number(item.controller_output_power_w_total.toFixed(3));
    }

    const lastDayKey = sortedDayKeys[sortedDayKeys.length - 1];
    if (lastDayKey && daily[lastDayKey].controller_output_power_w_total <= 0) {
      sortedDayKeys.pop();
    }

    for (const dayKey of sortedDayKeys) {
      const item = daily[dayKey];
      days.push(item);
      summaryLabels.push(dayKey);
      summaryValuesKwh.push(Number((item.controller_output_power_w_total / 1000.0).toFixed(3)));
      if (hasBattery) {
        baseTargetRows.push(
          this.recommendGridTarget(
            item,
            batteryCapacityKwh,
            assumedDailyUsageKwh,
            reservePercentFloor,
            socRoundingStepPercent,
            planningWindowStartHour,
            planningWindowEndHour,
          ),
        );
      }
    }

    const currentDayStartSocWh = !hasBattery || config.current_soc_at_0600_percent === null
      ? null
      : capacityWh * Math.max(0.0, Math.min(config.current_soc_at_0600_percent, 100.0)) / 100.0;

    const planContext: StrategyPlanContext = {
      capacityWh,
      reserveWh,
      currentDayStartSocWh,
      overnightDrainWh,
      daytimeLoadTotalWh,
      planningWindowStartHour,
      planningWindowEndHour,
    };

    const batteryPlan = hasBattery
      ? this.runStrategyPlan(config.strategy, days, baseTargetRows, config, planContext)
      : [];

    const strategyRecommendation = hasBattery
      ? this.recommendStrategy(days, baseTargetRows, config, planContext)
      : null;

    return {
      config,
      days,
      summary: {
        labels: summaryLabels,
        controller_output_kwh_total_by_day: summaryValuesKwh,
        forecast_total_controller_output_kwh: Number((forecastTotalController / 1000.0).toFixed(3)),
        forecast_total_pv_dc_kwh: Number((forecastTotalPv / 1000.0).toFixed(3)),
      },
      battery_plan: batteryPlan,
      battery_assumptions: {
        capacity_kwh: batteryCapacityKwh,
        reserve_percent_floor: reservePercentFloor,
        assumed_daily_usage_kwh: assumedDailyUsageKwh,
        night_load_kwh_per_hour: nightLoadKwhPerHour,
        night_hours_to_target: offPeakWindowDurationHours,
        soc_rounding_step_percent: socRoundingStepPercent,
        current_soc_at_0600_percent: hasBattery ? config.current_soc_at_0600_percent : null,
        strategy: config.strategy,
        off_peak_cost_p_per_kwh: config.off_peak_cost_p_per_kwh,
        off_peak_window: `${offPeakWindowStart}-${offPeakWindowEnd}`,
        off_peak_end_label: offPeakWindowEnd,
        on_peak_cost_p_per_kwh: config.on_peak_cost_p_per_kwh,
        sell_back_price_p_per_kwh: config.sell_back_price_p_per_kwh,
        planning_window: `${offPeakWindowEnd}-${String(planningWindowEndHour).padStart(2, '0')}:00`,
      },
      strategy_recommendation: strategyRecommendation,
    };
  }

  private runStrategyPlan(
    strategy: Strategy,
    days: DayForecast[],
    baseTargetRows: BatteryPlanRow[],
    config: ForecastConfig,
    ctx: StrategyPlanContext,
  ): BatteryPlanRow[] {
    const {
      capacityWh,
      reserveWh,
      currentDayStartSocWh,
      overnightDrainWh,
      daytimeLoadTotalWh,
      planningWindowStartHour,
      planningWindowEndHour,
    } = ctx;
    const rows = baseTargetRows.map((row) => ({ ...row }));

    let previousProjectedEndSocWh: number | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const dayEntry = days[index];
      const planningHours = dayEntry.times
        .map((timeLabel, i) => ({ hour: this.hourFromTimeLabel(timeLabel), solarWh: dayEntry.controller_output_power_w[i] }))
        .filter((item) => item.hour >= planningWindowStartHour && item.hour < planningWindowEndHour)
        .map((item) => item.solarWh);
      const loadWhPerHour = planningHours.length ? daytimeLoadTotalWh / planningHours.length : 0.0;

      let targetSocWh: number;
      if (strategy === 'sell-all' || strategy === 'balanced') {
        targetSocWh = capacityWh;
        row.recommended_target_percent_before_6am = 100.0;
        row.recommended_target_energy_kwh = Number((capacityWh / 1000.0).toFixed(3));
        row.grid_charge_from_reserve_floor_kwh = Number(Math.max(0.0, (capacityWh - reserveWh) / 1000.0).toFixed(3));
      } else {
        targetSocWh = row.recommended_target_energy_kwh * 1000.0;
      }

      let startSocWh: number;
      let socAt0600WithoutGridWh: number;
      if (index === 0) {
        if (currentDayStartSocWh === null) {
          row.grid_charge_0000_0600_recommendation = 'Depends on current SoC';
          startSocWh = targetSocWh;
          row.projected_soc_at_0600_without_grid_kwh = Number((targetSocWh / 1000.0).toFixed(3));
          row.actual_soc_at_0600_kwh = null;
        } else {
          startSocWh = currentDayStartSocWh;
          row.actual_soc_at_0600_kwh = Number((startSocWh / 1000.0).toFixed(3));
          row.projected_soc_at_0600_without_grid_kwh = Number((startSocWh / 1000.0).toFixed(3));
          row.grid_charge_0000_0600_recommendation = startSocWh >= targetSocWh ? 'OFF' : 'ON';
        }
        socAt0600WithoutGridWh = currentDayStartSocWh === null ? targetSocWh : startSocWh;
      } else {
        socAt0600WithoutGridWh = previousProjectedEndSocWh !== null
          ? previousProjectedEndSocWh - overnightDrainWh
          : targetSocWh;
        socAt0600WithoutGridWh = Math.max(0.0, Math.min(socAt0600WithoutGridWh, capacityWh));
        row.projected_soc_at_0600_without_grid_kwh = Number((socAt0600WithoutGridWh / 1000.0).toFixed(3));
        row.actual_soc_at_0600_kwh = null;
        if (socAt0600WithoutGridWh >= targetSocWh) {
          row.grid_charge_0000_0600_recommendation = 'OFF';
          startSocWh = socAt0600WithoutGridWh;
        } else {
          row.grid_charge_0000_0600_recommendation = 'ON';
          startSocWh = targetSocWh;
        }
      }

      if (strategy === 'sell-all' || strategy === 'balanced') {
        if (index === 0 && currentDayStartSocWh === null) {
          row.grid_charge_0000_0600_recommendation = 'ON';
          startSocWh = targetSocWh;
        } else if (socAt0600WithoutGridWh >= targetSocWh) {
          row.grid_charge_0000_0600_recommendation = 'OFF';
          startSocWh = socAt0600WithoutGridWh;
        } else {
          row.grid_charge_0000_0600_recommendation = 'ON';
          startSocWh = targetSocWh;
        }
      }

      const simulation = this.simulateDayStrategy(strategy, planningHours, startSocWh, loadWhPerHour, capacityWh, reserveWh);
      const projectedEndSocWh = Math.max(0.0, Math.min(simulation.end_soc_wh, capacityWh));
      const projectedMinSocWh = Math.max(0.0, Math.min(simulation.min_soc_wh, capacityWh));
      previousProjectedEndSocWh = projectedEndSocWh;

      const offPeakChargeWh = Math.max(0.0, startSocWh - socAt0600WithoutGridWh);
      const offPeakHouseWh = row.grid_charge_0000_0600_recommendation === 'ON' ? overnightDrainWh : 0.0;
      const offPeakImportWh = offPeakChargeWh + offPeakHouseWh;
      const onPeakImportWh = simulation.on_peak_import_wh;
      const solarSoldWh = simulation.solar_sold_wh;

      const costOffPeakP = (offPeakImportWh / 1000.0) * config.off_peak_cost_p_per_kwh;
      const costOnPeakP = (onPeakImportWh / 1000.0) * config.on_peak_cost_p_per_kwh;
      const earningsExportP = (solarSoldWh / 1000.0) * config.sell_back_price_p_per_kwh;
      const netPence = earningsExportP - (costOffPeakP + costOnPeakP);

      row.off_peak_import_kwh = Number((offPeakImportWh / 1000.0).toFixed(3));
      row.on_peak_import_kwh = Number((onPeakImportWh / 1000.0).toFixed(3));
      row.solar_export_kwh = Number((solarSoldWh / 1000.0).toFixed(3));
      row.daily_cost_off_peak_pence = Number(costOffPeakP.toFixed(2));
      row.daily_cost_on_peak_pence = Number(costOnPeakP.toFixed(2));
      row.daily_earnings_export_pence = Number(earningsExportP.toFixed(2));
      row.daily_net_pence = Number(netPence.toFixed(2));
      row.projected_end_of_day_soc_kwh = Number((projectedEndSocWh / 1000.0).toFixed(3));
      row.projected_end_of_day_soc_percent = Number(((projectedEndSocWh / capacityWh) * 100.0).toFixed(1));
      row.projected_min_soc_percent = Number(((projectedMinSocWh / capacityWh) * 100.0).toFixed(1));
      row.projected_reserve_breach = projectedMinSocWh < reserveWh;
    }

    return rows;
  }

  private strategyLabel(strategy: Strategy): string {
    switch (strategy) {
      case 'sell-all':
        return 'Sell all';
      case 'balanced':
        return 'Balanced';
      case 'zero-cost':
        return 'Zero cost';
      default:
        return strategy;
    }
  }

  private summarizeStrategy(strategy: Strategy, rows: BatteryPlanRow[]): StrategyComparison {
    let offPeakImportKwh = 0.0;
    let onPeakImportKwh = 0.0;
    let solarExportKwh = 0.0;
    let costOffPeakP = 0.0;
    let costOnPeakP = 0.0;
    let earningsExportP = 0.0;
    let netP = 0.0;

    for (const row of rows) {
      offPeakImportKwh += row.off_peak_import_kwh ?? 0.0;
      onPeakImportKwh += row.on_peak_import_kwh ?? 0.0;
      solarExportKwh += row.solar_export_kwh ?? 0.0;
      costOffPeakP += row.daily_cost_off_peak_pence ?? 0.0;
      costOnPeakP += row.daily_cost_on_peak_pence ?? 0.0;
      earningsExportP += row.daily_earnings_export_pence ?? 0.0;
      netP += row.daily_net_pence ?? 0.0;
    }

    return {
      strategy,
      label: this.strategyLabel(strategy),
      total_off_peak_import_kwh: Number(offPeakImportKwh.toFixed(3)),
      total_on_peak_import_kwh: Number(onPeakImportKwh.toFixed(3)),
      total_solar_export_kwh: Number(solarExportKwh.toFixed(3)),
      total_cost_off_peak_pence: Number(costOffPeakP.toFixed(2)),
      total_cost_on_peak_pence: Number(costOnPeakP.toFixed(2)),
      total_earnings_export_pence: Number(earningsExportP.toFixed(2)),
      total_net_pence: Number(netP.toFixed(2)),
    };
  }

  private recommendStrategy(
    days: DayForecast[],
    baseTargetRows: BatteryPlanRow[],
    config: ForecastConfig,
    ctx: StrategyPlanContext,
  ): StrategyRecommendation {
    const strategies: Strategy[] = ['zero-cost', 'balanced', 'sell-all'];
    const comparisons = strategies.map((strategy) =>
      this.summarizeStrategy(strategy, this.runStrategyPlan(strategy, days, baseTargetRows, config, ctx)),
    );

    // Pick the strategy with the best net financial outcome over the horizon.
    // Ties fall back to the earlier (more conservative) strategy in the list.
    const best = comparisons.reduce((winner, candidate) =>
      candidate.total_net_pence > winner.total_net_pence ? candidate : winner,
    );

    return {
      recommended_strategy: best.strategy,
      recommended_label: best.label,
      is_current_strategy: best.strategy === config.strategy,
      horizon_days: days.length,
      best,
      comparisons,
      explanation: this.buildStrategyExplanation(best, comparisons, config),
    };
  }

  private buildStrategyExplanation(
    best: StrategyComparison,
    comparisons: StrategyComparison[],
    config: ForecastConfig,
  ): string {
    const offPeak = config.off_peak_cost_p_per_kwh;
    const onPeak = config.on_peak_cost_p_per_kwh;
    const sellBack = config.sell_back_price_p_per_kwh;
    const tariffsUnset = offPeak === 0 && onPeak === 0 && sellBack === 0;

    const fmtNet = (value: number): string =>
      value >= 0
        ? `earn £${(value / 100).toFixed(2)}`
        : `spend £${(Math.abs(value) / 100).toFixed(2)}`;

    if (tariffsUnset) {
      return `No tariff prices are set (off-peak, on-peak and sell-back are all 0p/kWh), so every strategy nets out at £0.00 `
        + `and the strategies cannot be separated on cost. Enter your off-peak cost, on-peak cost and sell-back price to get a `
        + `meaningful recommendation. Until then, "${best.label}" is shown as a safe default that minimises grid import.`;
    }

    const sorted = [...comparisons].sort((a, b) => b.total_net_pence - a.total_net_pence);
    const runnerUp = sorted.find((entry) => entry.strategy !== best.strategy);
    const advantageText = runnerUp
      ? ` That is £${(Math.abs(best.total_net_pence - runnerUp.total_net_pence) / 100).toFixed(2)} better than "${runnerUp.label}" over the same period.`
      : '';

    let rationale: string;
    if (best.strategy === 'sell-all') {
      rationale = `With a sell-back price of ${sellBack.toFixed(2)}p/kWh relative to an on-peak rate of ${onPeak.toFixed(2)}p/kWh, `
        + `it pays to export all of your solar and cover the house from the grid. The battery is charged off-peak `
        + `(at ${offPeak.toFixed(2)}p/kWh) rather than from solar.`;
    } else if (best.strategy === 'balanced') {
      rationale = `Charging the battery to full off-peak (at ${offPeak.toFixed(2)}p/kWh) and using it to avoid on-peak import `
        + `(${onPeak.toFixed(2)}p/kWh), while still exporting surplus solar at ${sellBack.toFixed(2)}p/kWh, gives the best balance `
        + `of low running cost and export income.`;
    } else {
      rationale = `Charging only enough off-peak to get through the day and self-consuming your solar minimises expensive `
        + `on-peak import (${onPeak.toFixed(2)}p/kWh). With sell-back at only ${sellBack.toFixed(2)}p/kWh there is little `
        + `incentive to export, so keeping energy for your own use wins.`;
    }

    const gridCost = (best.total_cost_off_peak_pence + best.total_cost_on_peak_pence) / 100;
    const exportIncome = best.total_earnings_export_pence / 100;

    return `Over the forecast horizon, "${best.label}" gives the best financial outcome: you would ${fmtNet(best.total_net_pence)} `
      + `(£${exportIncome.toFixed(2)} export income minus £${gridCost.toFixed(2)} grid cost).${advantageText} ${rationale}`;
  }
}

export type {
  ForecastConfig,
  DayForecast,
  BatteryPlanRow,
  Strategy,
  StrategyComparison,
  StrategyRecommendation,
};
