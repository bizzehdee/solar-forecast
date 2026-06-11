# Solar Forecast

Solar Forecast is an Angular dashboard that estimates PV generation from Open-Meteo forecast data and produces a battery/grid charging plan.

## What it does

1. Pulls hourly weather and irradiance forecast data for your location (up to 16 days).
2. Models panel DC output and controller output using configurable panel/system inputs.
3. Displays:
   - A daily total summary chart.
   - Per-day hourly charts for controller output and cloud cover.
   - A battery planning table with recommended pre-06:00 target SoC.
4. Estimates daily economics using:
   - Off-peak import cost.
   - On-peak import cost.
   - Export/sell-back price.
5. Supports three operating strategies:
   - `sell-all`
   - `balanced`
   - `zero-cost`

## Inputs you can configure

- Location and panel geometry (`latitude`, `longitude`, `tilt`, `azimuth`)
- System values (`installed_watts`, `performance_ratio`, `controller_efficiency`, optional controller max output)
- Battery state at 06:00 (`current_soc_at_0600_percent`)
- Tariff values (off-peak, on-peak, sell-back)
- Dispatch strategy (`sell-all`, `balanced`, `zero-cost`)

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:4200/`.

## Other scripts

```bash
npm run build
npm test
```

## License

BSD 3-Clause. See `LICENSE`.
