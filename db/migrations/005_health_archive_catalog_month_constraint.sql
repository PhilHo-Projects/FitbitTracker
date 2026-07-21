ALTER TABLE health_archive_catalog
  ADD CONSTRAINT health_archive_catalog_archive_month_first_day_check
  CHECK (EXTRACT(DAY FROM archive_month) = 1);
