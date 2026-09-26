-- The offer's money content now includes where it sends people: its booking
-- link and its click destination, which brand-service serves per offer. The old
-- sales-funnel task counted those links, and the offer task does again.
--
-- Adding them changes every stored fingerprint's SHAPE, so a straight compare
-- on the next read would see every offer as "changed" and pay every due task.
-- Instead every fingerprint is reset to NULL: the next read adopts the current
-- content as the baseline, keeps the clock, and completes nothing (the same
-- path migration 0016 used for clocks carried from the funnel).
UPDATE "reward_task_states" SET "content_fingerprint" = NULL;
