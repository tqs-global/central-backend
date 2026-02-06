// Copyright 2025 India Datasets Platform
// Migration: Add pipelineProcessedAt column to photo_validation_status
// This tracks when a validated photo was sent to CVAT by the pipeline

const up = async (db) => {
    await db.raw(`
    ALTER TABLE photo_validation_status 
    ADD COLUMN IF NOT EXISTS "pipelineProcessedAt" TIMESTAMPTZ DEFAULT NULL
  `);

    // Add index for efficient querying of unprocessed validated photos
    await db.raw(`
    CREATE INDEX IF NOT EXISTS idx_pvs_pipeline_unprocessed 
    ON photo_validation_status (status, "pipelineProcessedAt") 
    WHERE status = 'validated' AND "pipelineProcessedAt" IS NULL
  `);
};

const down = async (db) => {
    await db.raw(`DROP INDEX IF EXISTS idx_pvs_pipeline_unprocessed`);
    await db.raw(`ALTER TABLE photo_validation_status DROP COLUMN IF EXISTS "pipelineProcessedAt"`);
};

module.exports = { up, down };
