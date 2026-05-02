export const TIERS = {
  free_trial: {
    features: ['bump'] as string[],
    stripePriceIds: [] as string[],
    limits: { bumpsPerDay: 10 },
  },
  basic: {
    features: ['bump', 'follow'] as string[],
    stripePriceIds: ['price_1TS843FbOv6MHXgUE60E7CaQ', 'price_1TS843FbOv6MHXgUAflfsBVg'],
    limits: { bumpsPerDay: 50, followsPerDay: 80 },
  },
  pro: {
    features: ['bump', 'follow', 'message', 'stealth'] as string[],
    stripePriceIds: ['price_1TS844FbOv6MHXgUNrzlxf7A', 'price_1TS844FbOv6MHXgUcAIMSJRm'],
    limits: { bumpsPerDay: 150, followsPerDay: 200, messagesPerDay: 40 },
  },
  pro_plus: {
    features: ['bump', 'follow', 'message', 'stealth', 'relist'] as string[],
    stripePriceIds: ['price_1TS844FbOv6MHXgUYP35NVJz', 'price_1TS844FbOv6MHXgUouHUz7Ir'],
    limits: { bumpsPerDay: 300, followsPerDay: 300, messagesPerDay: 80, relistsPerDay: 30 },
  },
} as const;

export type TierName = keyof typeof TIERS;

export function tierFromLookupKey(lookupKey: string): TierName {
  if (lookupKey.startsWith('proplus')) return 'pro_plus';
  if (lookupKey.startsWith('pro')) return 'pro';
  if (lookupKey.startsWith('basic')) return 'basic';
  return 'free_trial';
}

export function featuresForTier(tier: string): string[] {
  return (TIERS[tier as TierName]?.features ?? TIERS.free_trial.features) as string[];
}

export function limitsForTier(tier: string): Record<string, number> {
  return TIERS[tier as TierName]?.limits ?? TIERS.free_trial.limits;
}
