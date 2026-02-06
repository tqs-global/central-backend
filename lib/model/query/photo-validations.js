// Copyright 2025 India Datasets Platform
// Photo Validations Query Module
// Database operations for the Photo Validation Game

const { sql } = require('slonik');

// Threshold for consensus (number of votes needed)
const CONSENSUS_THRESHOLD = 25;
const AGREEMENT_THRESHOLD = 0.80;  // 80% agreement required

// Minimum photos required for a meaningful game
const MIN_PHOTOS_FOR_GAME = 4;      // At least 4 photos total
const MIN_DISTRACTORS = 1;          // At least 1 distractor for CAPTCHA-style

////////////////////////////////////////////////////////////////////////////////
// RECORD VALIDATION

const recordValidation = (data) => ({ run }) => run(sql`
  INSERT INTO photo_validations 
    ("submissionDefId", "attachmentName", "validatorId", "expectedValue", "userSelected", "createdAt")
  VALUES 
    (${data.submissionDefId}, ${data.attachmentName}, ${data.validatorId}, ${data.expectedValue}, ${data.userSelected}, NOW())
`);

////////////////////////////////////////////////////////////////////////////////
// GET PHOTOS FOR VALIDATION

const getPhotosForValidation = (formId, validatorId, count) => ({ all }) => all(sql`
  SELECT 
    pvs.id,
    pvs."submissionDefId",
    pvs."attachmentName",
    pvs."submittedValue" as "expectedValue",
    sd."instanceId",
    sub."instanceId" as "rootInstanceId"
  FROM photo_validation_status pvs
  JOIN submission_defs sd ON sd.id = pvs."submissionDefId"
  JOIN submissions sub ON sub.id = sd."submissionId"
  WHERE sub."formId" = ${formId}
    AND pvs.status = 'pending'
    AND pvs."validationCount" < ${CONSENSUS_THRESHOLD}
    -- Exclude photos submitted by this user (can't validate own photos)
    AND sub."submitterId" IS DISTINCT FROM ${validatorId}
    -- Exclude photos already validated by this user
    AND NOT EXISTS (
      SELECT 1 FROM photo_validations pv
      WHERE pv."submissionDefId" = pvs."submissionDefId"
        AND pv."attachmentName" = pvs."attachmentName"
        AND pv."validatorId" = ${validatorId}
    )
  ORDER BY pvs."validationCount" ASC, pvs."updatedAt" ASC
  LIMIT ${count}
`);

////////////////////////////////////////////////////////////////////////////////
// UPDATE CONSENSUS

const updateConsensus = (submissionDefId, attachmentName) => ({ run, one }) =>
  one(sql`
    -- Get validation summary
    SELECT 
      COUNT(*) as total_votes,
      SUM(CASE WHEN "userSelected" = true THEN 1 ELSE 0 END) as positive_votes,
      SUM(CASE WHEN "userSelected" = false THEN 1 ELSE 0 END) as negative_votes
    FROM photo_validations
    WHERE "submissionDefId" = ${submissionDefId}
      AND "attachmentName" = ${attachmentName}
  `).then(({ total_votes, positive_votes, negative_votes }) => {
    const totalVotes = parseInt(total_votes);

    if (totalVotes >= CONSENSUS_THRESHOLD) {
      // Determine consensus
      const positiveRatio = positive_votes / totalVotes;
      let status = 'validated';
      let consensusValue = null;

      if (positiveRatio >= AGREEMENT_THRESHOLD) {
        // Strong agreement (80%+) - correct match
        consensusValue = 'correct';
      } else if (positiveRatio <= (1 - AGREEMENT_THRESHOLD)) {
        // Strong disagreement (20%-) - likely mismatch
        status = 'flagged';
        consensusValue = 'mismatch';
      } else {
        // Unclear consensus (between 20%-80%)
        status = 'flagged';
        consensusValue = 'unclear';
      }

      return run(sql`
        UPDATE photo_validation_status
        SET 
          "validationCount" = ${totalVotes},
          "consensusValue" = ${consensusValue},
          "status" = ${status},
          "updatedAt" = NOW()
        WHERE "submissionDefId" = ${submissionDefId}
          AND "attachmentName" = ${attachmentName}
      `);
    } else {
      // Just update the count
      return run(sql`
        UPDATE photo_validation_status
        SET 
          "validationCount" = ${totalVotes},
          "updatedAt" = NOW()
        WHERE "submissionDefId" = ${submissionDefId}
          AND "attachmentName" = ${attachmentName}
      `);
    }
  });

////////////////////////////////////////////////////////////////////////////////
// GET FORMS WITH PENDING VALIDATIONS

const getFormsWithPendingValidations = (formIds) => ({ all }) => {
  if (formIds.length === 0) return Promise.resolve([]);

  return all(sql`
    SELECT 
      f.id,
      f."projectId",
      f."xmlFormId",
      f.name,
      COALESCE(pending.count, 0) as "pendingCount"
    FROM forms f
    LEFT JOIN (
      SELECT sub."formId", COUNT(*) as count
      FROM photo_validation_status pvs
      JOIN submission_defs sd ON sd.id = pvs."submissionDefId"
      JOIN submissions sub ON sub.id = sd."submissionId"
      WHERE pvs.status = 'pending'
      GROUP BY sub."formId"
    ) pending ON pending."formId" = f.id
    WHERE f.id = ANY(${sql.array(formIds, 'int4')})
      AND f."deletedAt" IS NULL
    ORDER BY "pendingCount" DESC
  `);
};

////////////////////////////////////////////////////////////////////////////////
// GET DISEASE CHOICES FROM FORM

const getDiseaseChoicesFromForm = (formId) => ({ all }) => all(sql`
  SELECT DISTINCT ff.path, ff.name, ff."selectMultiple"
  FROM form_fields ff
  JOIN form_schemas fs ON fs.id = ff."schemaId"
  JOIN form_defs fd ON fd."schemaId" = fs.id
  JOIN forms f ON f.id = fd."formId" AND fd.id = f."currentDefId"
  WHERE f.id = ${formId}
    AND ff.type = 'select1'
    AND (ff.name ILIKE '%disease%' OR ff.name ILIKE '%pest%' OR ff.name ILIKE '%symptom%')
`).then(fields => {
  // Return unique disease-related choices
  return fields.map(f => ({
    fieldPath: f.path,
    fieldName: f.name,
    isMultiple: f.selectMultiple
  }));
});

////////////////////////////////////////////////////////////////////////////////
// GET STATS FOR VALIDATOR

const getStatsForValidator = (validatorId) => ({ one }) => one(sql`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN pv."userSelected" = true THEN 1 ELSE 0 END) as correct,
    (
      SELECT COUNT(*) + 1 
      FROM (
        SELECT "validatorId", COUNT(*) as cnt
        FROM photo_validations
        GROUP BY "validatorId"
        HAVING COUNT(*) > (
          SELECT COUNT(*) FROM photo_validations WHERE "validatorId" = ${validatorId}
        )
      ) as ranks
    ) as rank
  FROM photo_validations pv
  WHERE pv."validatorId" = ${validatorId}
`);

////////////////////////////////////////////////////////////////////////////////
// GET STATUS BY PHOTO

const getStatusByPhoto = (submissionDefId, attachmentName) => ({ maybeOne }) => maybeOne(sql`
  SELECT * FROM photo_validation_status
  WHERE "submissionDefId" = ${submissionDefId}
    AND "attachmentName" = ${attachmentName}
`);

////////////////////////////////////////////////////////////////////////////////
// INITIALIZE STATUS FOR NEW PHOTO (called when submission is created)

const initializePhotoStatus = (submissionDefId, attachmentName, fieldName, submittedValue) => ({ run }) => run(sql`
  INSERT INTO photo_validation_status 
    ("submissionDefId", "attachmentName", "fieldName", "submittedValue", "validationCount", "status", "updatedAt")
  VALUES 
    (${submissionDefId}, ${attachmentName}, ${fieldName}, ${submittedValue}, 0, 'pending', NOW())
  ON CONFLICT ("submissionDefId", "attachmentName") 
  DO NOTHING
`);

////////////////////////////////////////////////////////////////////////////////
// GET DISEASE VALUE FROM SUBMISSION (for post-submission game)

const getDiseaseValueFromSubmission = (submissionDefId) => ({ maybeOne }) => maybeOne(sql`
  SELECT pvs."submittedValue", pvs."fieldName"
  FROM photo_validation_status pvs
  WHERE pvs."submissionDefId" = ${submissionDefId}
  LIMIT 1
`).then(result => result ? result.submittedValue : null);

////////////////////////////////////////////////////////////////////////////////
// GET CAPTCHA-STYLE MIXED PHOTOS (for contextual post-submission game)
// Returns a mix: half matching the disease, half distractors (other diseases/healthy)

const getPhotosWithSameDisease = (formId, diseaseValue, excludeValidatorId, count) => async ({ all }) => {
  // If no disease value, return any pending photos
  if (!diseaseValue) {
    return all(sql`
      SELECT 
        pvs.id,
        pvs."submissionDefId",
        pvs."attachmentName",
        pvs."submittedValue" as "expectedValue",
        sd."instanceId",
        true as "isMatch"
      FROM photo_validation_status pvs
      JOIN submission_defs sd ON sd.id = pvs."submissionDefId"
      JOIN submissions sub ON sub.id = sd."submissionId"
      WHERE sub."formId" = ${formId}
        AND pvs.status = 'pending'
        AND sub."submitterId" IS DISTINCT FROM ${excludeValidatorId}
      ORDER BY pvs."validationCount" ASC
      LIMIT ${count}
    `);
  }

  // CAPTCHA-style: Get half matching + half distractors
  const halfCount = Math.ceil(count / 2);

  // Get MATCHING photos (correct answers)
  const matchingPhotos = await all(sql`
    SELECT 
      pvs.id,
      pvs."submissionDefId",
      pvs."attachmentName",
      pvs."submittedValue" as "expectedValue",
      sd."instanceId",
      true as "isMatch"
    FROM photo_validation_status pvs
    JOIN submission_defs sd ON sd.id = pvs."submissionDefId"
    JOIN submissions sub ON sub.id = sd."submissionId"
    WHERE sub."formId" = ${formId}
      AND pvs.status = 'pending'
      AND pvs."submittedValue" = ${diseaseValue}
      AND sub."submitterId" IS DISTINCT FROM ${excludeValidatorId}
      AND NOT EXISTS (
        SELECT 1 FROM photo_validations pv
        WHERE pv."submissionDefId" = pvs."submissionDefId"
          AND pv."attachmentName" = pvs."attachmentName"
          AND pv."validatorId" = ${excludeValidatorId}
      )
    ORDER BY pvs."validationCount" ASC
    LIMIT ${halfCount}
  `);

  // Get DISTRACTOR photos (different diseases/healthy - wrong answers)
  const distractorPhotos = await all(sql`
    SELECT 
      pvs.id,
      pvs."submissionDefId",
      pvs."attachmentName",
      pvs."submittedValue" as "expectedValue",
      sd."instanceId",
      false as "isMatch"
    FROM photo_validation_status pvs
    JOIN submission_defs sd ON sd.id = pvs."submissionDefId"
    JOIN submissions sub ON sub.id = sd."submissionId"
    WHERE sub."formId" = ${formId}
      AND pvs.status = 'pending'
      AND pvs."submittedValue" IS DISTINCT FROM ${diseaseValue}
      AND sub."submitterId" IS DISTINCT FROM ${excludeValidatorId}
      AND NOT EXISTS (
        SELECT 1 FROM photo_validations pv
        WHERE pv."submissionDefId" = pvs."submissionDefId"
          AND pv."attachmentName" = pvs."attachmentName"
          AND pv."validatorId" = ${excludeValidatorId}
      )
    ORDER BY RANDOM()
    LIMIT ${halfCount}
  `);

  // Check minimum thresholds for meaningful game
  const totalPhotos = matchingPhotos.length + distractorPhotos.length;

  // Not enough photos for a meaningful game
  if (totalPhotos < MIN_PHOTOS_FOR_GAME) {
    return { insufficient: true, reason: 'not_enough_photos', available: totalPhotos, required: MIN_PHOTOS_FOR_GAME };
  }

  // Not enough distractors for CAPTCHA-style
  if (distractorPhotos.length < MIN_DISTRACTORS) {
    return { insufficient: true, reason: 'not_enough_distractors', available: distractorPhotos.length, required: MIN_DISTRACTORS };
  }

  // Shuffle combined results so user can't predict positions
  const combined = [...matchingPhotos, ...distractorPhotos];
  for (let i = combined.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }

  return combined;
};

////////////////////////////////////////////////////////////////////////////////
// GET VALIDATED PHOTOS (for pipeline consumption)
// Returns photos that have reached consensus and are validated

const getValidatedPhotos = (formId, limit = 100) => ({ all }) => all(sql`
  SELECT 
    pvs.id,
    pvs."submissionDefId",
    pvs."attachmentName",
    pvs."submittedValue",
    pvs."consensusValue",
    pvs."validationCount",
    pvs."updatedAt" as "validatedAt",
    sd."instanceId",
    sub."instanceId" as "rootInstanceId",
    sub."createdAt" as "submittedAt"
  FROM photo_validation_status pvs
  JOIN submission_defs sd ON sd.id = pvs."submissionDefId"
  JOIN submissions sub ON sub.id = sd."submissionId"
  WHERE sub."formId" = ${formId}
    AND pvs.status = 'validated'
    AND pvs."consensusValue" = 'correct'
  ORDER BY pvs."updatedAt" DESC
  LIMIT ${limit}
`);

////////////////////////////////////////////////////////////////////////////////
// MARK PHOTO AS PROCESSED (after pipeline sends to CVAT)

const markPhotoAsProcessed = (submissionDefId, attachmentName) => ({ run }) => run(sql`
  UPDATE photo_validation_status
  SET 
    "pipelineProcessedAt" = NOW(),
    "updatedAt" = NOW()
  WHERE "submissionDefId" = ${submissionDefId}
    AND "attachmentName" = ${attachmentName}
`);

////////////////////////////////////////////////////////////////////////////////
// GET UNPROCESSED VALIDATED PHOTOS (validated but not yet sent to CVAT)

const getUnprocessedValidatedPhotos = (formId, limit = 100) => ({ all }) => all(sql`
  SELECT 
    pvs.id,
    pvs."submissionDefId",
    pvs."attachmentName",
    pvs."submittedValue",
    pvs."consensusValue",
    pvs."validationCount",
    pvs."updatedAt" as "validatedAt",
    sd."instanceId",
    sub."instanceId" as "rootInstanceId",
    sub."createdAt" as "submittedAt"
  FROM photo_validation_status pvs
  JOIN submission_defs sd ON sd.id = pvs."submissionDefId"
  JOIN submissions sub ON sub.id = sd."submissionId"
  WHERE sub."formId" = ${formId}
    AND pvs.status = 'validated'
    AND pvs."consensusValue" = 'correct'
    AND pvs."pipelineProcessedAt" IS NULL
  ORDER BY pvs."updatedAt" ASC
  LIMIT ${limit}
`);

////////////////////////////////////////////////////////////////////////////////
// ADMIN FORCE VALIDATE (for testing purposes)
// Bypasses the validation game and directly marks photos as validated

const adminForceValidate = (formId, limit = 100) => ({ run, all }) =>
  all(sql`
    SELECT 
      pvs.id,
      pvs."submissionDefId",
      pvs."attachmentName"
    FROM photo_validation_status pvs
    JOIN submission_defs sd ON sd.id = pvs."submissionDefId"
    JOIN submissions sub ON sub.id = sd."submissionId"
    WHERE sub."formId" = ${formId}
      AND pvs.status = 'pending'
    LIMIT ${limit}
  `).then(photos => {
    if (photos.length === 0) return { updated: 0 };

    const ids = photos.map(p => p.id);
    return run(sql`
      UPDATE photo_validation_status
      SET 
        status = 'validated',
        "consensusValue" = 'correct',
        "validationCount" = 25,
        "updatedAt" = NOW()
      WHERE id = ANY(${sql.array(ids, 'int4')})
    `).then(() => ({ updated: photos.length, photos }));
  });

////////////////////////////////////////////////////////////////////////////////
// GET ALL PENDING PHOTOS (for admin view)

const getPendingPhotos = (formId, limit = 100) => ({ all }) => all(sql`
  SELECT 
    pvs.id,
    pvs."submissionDefId",
    pvs."attachmentName",
    pvs."submittedValue",
    pvs."validationCount",
    pvs.status,
    sd."instanceId",
    sub."createdAt" as "submittedAt"
  FROM photo_validation_status pvs
  JOIN submission_defs sd ON sd.id = pvs."submissionDefId"
  JOIN submissions sub ON sub.id = sd."submissionId"
  WHERE sub."formId" = ${formId}
    AND pvs.status = 'pending'
  ORDER BY pvs."updatedAt" ASC
  LIMIT ${limit}
`);

module.exports = {
  recordValidation,
  getPhotosForValidation,
  updateConsensus,
  getFormsWithPendingValidations,
  getDiseaseChoicesFromForm,
  getStatsForValidator,
  getStatusByPhoto,
  initializePhotoStatus,
  getDiseaseValueFromSubmission,
  getPhotosWithSameDisease,
  getValidatedPhotos,
  markPhotoAsProcessed,
  getUnprocessedValidatedPhotos,
  adminForceValidate,
  getPendingPhotos,
  CONSENSUS_THRESHOLD,
  MIN_PHOTOS_FOR_GAME,
  MIN_DISTRACTORS
};
