import { describe, it, expect } from 'vitest';
import {
  TIERS,
  tierFromLookupKey,
  featuresForTier,
  limitsForTier,
} from '../../src/services/tier-map.js';

describe('tier-map', () => {
  describe('tierFromLookupKey', () => {
    it('maps proplus_* to pro_plus', () => {
      expect(tierFromLookupKey('proplus_monthly')).toBe('pro_plus');
      expect(tierFromLookupKey('proplus_annual')).toBe('pro_plus');
    });
    it('maps pro_* to pro', () => {
      expect(tierFromLookupKey('pro_monthly')).toBe('pro');
      expect(tierFromLookupKey('pro_annual')).toBe('pro');
    });
    it('maps basic_* to basic', () => {
      expect(tierFromLookupKey('basic_monthly')).toBe('basic');
      expect(tierFromLookupKey('basic_annual')).toBe('basic');
    });
    it('falls back to free_trial for unknown keys', () => {
      expect(tierFromLookupKey('')).toBe('free_trial');
      expect(tierFromLookupKey('garbage')).toBe('free_trial');
    });
  });

  describe('featuresForTier', () => {
    it('returns expected features for each tier', () => {
      expect(featuresForTier('free_trial')).toEqual(['bump']);
      expect(featuresForTier('basic')).toEqual(['bump', 'follow']);
      expect(featuresForTier('pro')).toEqual(['bump', 'follow', 'message', 'stealth']);
      expect(featuresForTier('pro_plus')).toEqual(['bump', 'follow', 'message', 'stealth', 'relist']);
    });
    it('falls back to free_trial features for unknown tier', () => {
      expect(featuresForTier('mystery')).toEqual(['bump']);
    });
  });

  describe('limitsForTier', () => {
    it('returns limits for each tier', () => {
      expect(limitsForTier('free_trial')).toEqual({ bumpsPerDay: 10 });
      expect(limitsForTier('basic').bumpsPerDay).toBe(50);
      expect(limitsForTier('pro').messagesPerDay).toBe(40);
      expect(limitsForTier('pro_plus').relistsPerDay).toBe(30);
    });
    it('falls back for unknown tier', () => {
      expect(limitsForTier('mystery')).toEqual({ bumpsPerDay: 10 });
    });
  });

  describe('TIERS structural invariants', () => {
    it('all paid tiers list at least one Stripe price id', () => {
      for (const name of ['basic', 'pro', 'pro_plus'] as const) {
        expect(TIERS[name].stripePriceIds.length).toBeGreaterThan(0);
      }
    });
  });
});
