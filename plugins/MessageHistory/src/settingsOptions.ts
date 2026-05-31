export type NumericSetting = "maxTotalRecords" | "maxRecordsPerChannel" | "maxRecordsPerMessage" | "maxAgeDays";

export const SETTING_OPTIONS: Record<NumericSetting, number[]> = {
    maxTotalRecords: [50, 100, 200, 500],
    maxRecordsPerChannel: [10, 25, 50, 100],
    maxRecordsPerMessage: [3, 5, 10, 20],
    maxAgeDays: [1, 3, 7, 14, 30],
};

export function nextOptionValue(key: NumericSetting, current: number): number {
    const options = SETTING_OPTIONS[key];
    const index = options.indexOf(current);
    if (index < 0) return options[0];
    return options[(index + 1) % options.length];
}

export function cycleNumericSetting<T extends Record<NumericSetting, number>>(settings: T, key: NumericSetting): T {
    return {
        ...settings,
        [key]: nextOptionValue(key, settings[key]),
    };
}
