-- The start page's "Features" switch: the asks that offer a feature not
-- used yet (the emergency card for Wallet) follow `feature_offer` in the
-- layout's `enabledHeroItemKinds`.
--
-- The list stores the ENABLED kinds, and only when it is not all of them. A
-- list saved before `feature_offer` existed would read as "switched off",
-- although nobody switched it off. Append it to every stored, non-empty list
-- that lacks it. An empty list is every ask category turned off and stays
-- empty; a stored value that is not a list is left alone.
UPDATE "users"
SET "dashboard_widgets_json" = jsonb_set(
      "dashboard_widgets_json",
      '{enabledHeroItemKinds}',
      ("dashboard_widgets_json" -> 'enabledHeroItemKinds') || '["feature_offer"]'::jsonb
    )
WHERE CASE
    WHEN jsonb_typeof("dashboard_widgets_json" -> 'enabledHeroItemKinds') = 'array'
    THEN jsonb_array_length("dashboard_widgets_json" -> 'enabledHeroItemKinds') > 0
      AND NOT ("dashboard_widgets_json" -> 'enabledHeroItemKinds') ? 'feature_offer'
    ELSE FALSE
  END;
