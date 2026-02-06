// Copyright 2025 India Datasets Platform
// Photo Validation Game API
// Implements CAPTCHA-style photo validation for disease identification

const { getOrNotFound } = require('../util/promise');
const { success } = require('../util/http');
const { Form } = require('../model/frames');
const { QueryOptions } = require('../util/db');

module.exports = (service, endpoint) => {

    ////////////////////////////////////////////////////////////////////////////////
    // GAME DISCOVERY - Forms available for validation

    service.get('/validations/my-forms', endpoint(async ({ Forms, PhotoValidations }, { auth }) => {
        // Get forms the user can validate (forms with photo attachments and disease fields)
        const actor = auth.actor.orElseGet(() => { throw new Error('Authentication required'); });

        // Get all forms user has access to
        const forms = await Forms.getAllByAuth(auth);

        // Filter to forms with pending validations
        const formsWithPending = await PhotoValidations.getFormsWithPendingValidations(
            forms.map(f => f.id)
        );

        return formsWithPending.map(form => ({
            projectId: form.projectId,
            xmlFormId: form.xmlFormId,
            name: form.name,
            pendingCount: form.pendingCount
        }));
    }));

    ////////////////////////////////////////////////////////////////////////////////
    // GAME SESSION - Get a set of photos to validate

    service.get('/validations/game-session', endpoint(async ({ Forms, PhotoValidations, SubmissionAttachments }, { auth, query }) => {
        const actor = auth.actor.orElseGet(() => { throw new Error('Authentication required'); });
        const { projectId, formId, count = 6 } = query;

        if (!projectId || !formId) {
            throw new Error('projectId and formId are required');
        }

        // Get form and verify access
        const form = await Forms.getByProjectAndXmlFormId(parseInt(projectId), formId, Form.PublishedVersion, Form.WithoutXml, QueryOptions.none)
            .then(getOrNotFound);

        // Get photos needing validation (not yet validated by this user)
        const photos = await PhotoValidations.getPhotosForValidation(
            form.id,
            actor.id,
            parseInt(count)
        );

        // Get disease choices from form definition
        const diseaseChoices = await PhotoValidations.getDiseaseChoicesFromForm(form.id);

        // Build game session
        return {
            sessionId: `session_${Date.now()}_${actor.id}`,
            formId: formId,
            projectId: projectId,
            photos: photos.map(photo => ({
                id: photo.id,
                submissionDefId: photo.submissionDefId,
                attachmentName: photo.attachmentName,
                imageUrl: `/v1/projects/${projectId}/forms/${formId}/submissions/${photo.instanceId}/attachments/${photo.attachmentName}`,
                expectedValue: photo.expectedValue
            })),
            diseaseChoices: diseaseChoices,
            totalPhotos: photos.length
        };
    }));

    ////////////////////////////////////////////////////////////////////////////////
    // POST-SUBMISSION GAME SESSION - Contextual game after form submission
    // Shows photos matching the disease the user just submitted

    service.get('/validations/post-submission-session', endpoint(async ({ Forms, PhotoValidations, Submissions }, { auth, query }) => {
        const actor = auth.actor.orElseGet(() => { throw new Error('Authentication required'); });
        const { projectId, formId, submissionId, count = 6 } = query;

        if (!projectId || !formId || !submissionId) {
            throw new Error('projectId, formId, and submissionId are required');
        }

        // Get form
        const form = await Forms.getByProjectAndXmlFormId(parseInt(projectId), formId)
            .then(getOrNotFound);

        // Get the user's submission to find what disease they identified
        const userSubmission = await Submissions.getByIds(parseInt(projectId), formId, submissionId, false)
            .then(getOrNotFound);

        // Get disease value from user's submission
        const diseaseValue = await PhotoValidations.getDiseaseValueFromSubmission(
            userSubmission.aux?.currentVersion?.id || userSubmission.id
        );

        // Get mixed photos (CAPTCHA-style: matching + distractors)
        const mixedPhotos = await PhotoValidations.getPhotosWithSameDisease(
            form.id,
            diseaseValue,
            actor.id,
            parseInt(count)
        );

        // Check if we have enough photos for a meaningful game
        if (mixedPhotos && mixedPhotos.insufficient) {
            return {
                gameAvailable: false,
                reason: mixedPhotos.reason,
                message: mixedPhotos.reason === 'not_enough_photos'
                    ? `Not enough photos yet (${mixedPhotos.available}/${mixedPhotos.required} needed). Check back later!`
                    : `Need more variety in photos for validation. Check back later!`,
                available: mixedPhotos.available,
                required: mixedPhotos.required
            };
        }

        // Count matching photos for instructions
        const matchingCount = mixedPhotos.filter(p => p.isMatch).length;

        // Build CAPTCHA-style game session
        return {
            gameAvailable: true,
            sessionId: `post_${Date.now()}_${actor.id}`,
            type: 'post-submission-captcha',
            formId: formId,
            projectId: projectId,
            targetDisease: diseaseValue,
            // CAPTCHA-style instruction
            instruction: diseaseValue
                ? `Select all photos showing "${diseaseValue}"`
                : 'Select all correctly identified photos',
            contextMessage: diseaseValue
                ? `You submitted "${diseaseValue}". Now select OTHER photos that show the same condition.`
                : 'Help verify submissions from other farmers!',
            photos: mixedPhotos.map(photo => ({
                id: photo.id,
                submissionDefId: photo.submissionDefId,
                attachmentName: photo.attachmentName,
                imageUrl: `/v1/projects/${projectId}/forms/${formId}/submissions/${photo.instanceId}/attachments/${photo.attachmentName}`,
                // Don't expose isMatch to frontend - that's the answer!
                // Frontend will validate against this after submission
                _correctAnswer: photo.isMatch  // Hidden from UI, used for scoring
            })),
            totalPhotos: mixedPhotos.length,
            expectedMatches: matchingCount,  // For scoring (hidden from naive users)
            skipAllowed: true
        };
    }));

    ////////////////////////////////////////////////////////////////////////////////
    // SUBMIT VALIDATION - Record user's validation choices

    service.post('/validations/submit', endpoint(async ({ PhotoValidations, Audits }, { auth, body }) => {
        const actor = auth.actor.orElseGet(() => { throw new Error('Authentication required'); });

        const { sessionId, validations } = body;

        if (!validations || !Array.isArray(validations)) {
            throw new Error('validations array is required');
        }

        let correct = 0;
        let total = validations.length;

        for (const validation of validations) {
            const { submissionDefId, attachmentName, expectedValue, userSelected } = validation;

            // Record the validation
            await PhotoValidations.recordValidation({
                submissionDefId,
                attachmentName,
                validatorId: actor.id,
                expectedValue,
                userSelected
            });

            if (userSelected === true) correct++;

            // Check and update consensus
            await PhotoValidations.updateConsensus(submissionDefId, attachmentName);
        }

        // Log audit
        await Audits.log(actor, 'validation.submit', null, {
            sessionId,
            validationCount: total,
            correctCount: correct
        });

        return {
            success: true,
            validated: total,
            score: Math.round((correct / total) * 100),
            message: `You validated ${total} photos with ${correct} correct selections`
        };
    }));

    ////////////////////////////////////////////////////////////////////////////////
    // VALIDATION STATS - Get user's validation statistics

    service.get('/validations/stats', endpoint(async ({ PhotoValidations }, { auth }) => {
        const actor = auth.actor.orElseGet(() => { throw new Error('Authentication required'); });

        const stats = await PhotoValidations.getStatsForValidator(actor.id);

        return {
            totalValidations: stats.total || 0,
            correctSelections: stats.correct || 0,
            accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
            rank: stats.rank || null,
            recentActivity: stats.recent || []
        };
    }));

    ////////////////////////////////////////////////////////////////////////////////
    // CONSENSUS STATUS - Get consensus status for a photo

    service.get('/validations/status/:submissionDefId/:attachmentName', endpoint(async ({ PhotoValidations, auth }) => {
        const { submissionDefId, attachmentName } = auth.params;

        const status = await PhotoValidations.getStatusByPhoto(
            parseInt(submissionDefId),
            attachmentName
        );

        if (!status) {
            return { status: 'pending', validationCount: 0 };
        }

        return {
            status: status.status,
            validationCount: status.validationCount,
            consensusValue: status.consensusValue,
            submittedValue: status.submittedValue
        };
    }));

    ////////////////////////////////////////////////////////////////////////////////
    // VALIDATED PHOTOS - Get photos ready for pipeline processing
    // Used by the Agricultural Pipeline to fetch validated photos for enrichment

    service.get('/validations/validated-photos', endpoint(async ({ Forms, PhotoValidations }, { auth, query }) => {
        const actor = auth.actor.orElseGet(() => { throw new Error('Authentication required'); });
        const { projectId, formId, limit = 100, unprocessedOnly = 'true' } = query;

        if (!projectId || !formId) {
            throw new Error('projectId and formId are required');
        }

        // Get form and verify access
        const form = await Forms.getByProjectAndXmlFormId(parseInt(projectId), formId, Form.PublishedVersion, Form.WithoutXml, QueryOptions.none)
            .then(getOrNotFound);

        // Get validated photos (optionally only unprocessed ones)
        const photos = unprocessedOnly === 'true'
            ? await PhotoValidations.getUnprocessedValidatedPhotos(form.id, parseInt(limit))
            : await PhotoValidations.getValidatedPhotos(form.id, parseInt(limit));

        return {
            projectId,
            formId,
            count: photos.length,
            photos: photos.map(photo => ({
                id: photo.id,
                submissionDefId: photo.submissionDefId,
                instanceId: photo.instanceId || photo.rootInstanceId,
                attachmentName: photo.attachmentName,
                imageUrl: `/v1/projects/${projectId}/forms/${formId}/submissions/${photo.instanceId || photo.rootInstanceId}/attachments/${photo.attachmentName}`,
                submittedValue: photo.submittedValue,
                consensusValue: photo.consensusValue,
                validationCount: photo.validationCount,
                validatedAt: photo.validatedAt,
                submittedAt: photo.submittedAt
            }))
        };
    }));

    ////////////////////////////////////////////////////////////////////////////////
    // MARK PROCESSED - Mark photos as processed by pipeline (sent to CVAT)

    service.post('/validations/mark-processed', endpoint(async ({ PhotoValidations, Audits }, { auth, body }) => {
        const actor = auth.actor.orElseGet(() => { throw new Error('Authentication required'); });

        const { photos } = body;

        if (!photos || !Array.isArray(photos)) {
            throw new Error('photos array is required');
        }

        let processed = 0;
        for (const photo of photos) {
            const { submissionDefId, attachmentName } = photo;
            await PhotoValidations.markPhotoAsProcessed(submissionDefId, attachmentName);
            processed++;
        }

        // Log audit
        await Audits.log(actor, 'validation.pipeline-processed', null, {
            photoCount: processed
        });

        return {
            success: true,
            processed: processed,
            message: `Marked ${processed} photos as processed by pipeline`
        };
    }));

    ////////////////////////////////////////////////////////////////////////////////
    // ADMIN ENDPOINTS - For testing and debugging
    ////////////////////////////////////////////////////////////////////////////////

    // Get pending photos (admin view)
    service.get('/validations/admin/pending', endpoint(async ({ Forms, PhotoValidations }, { auth, query }) => {
        const actor = auth.actor.orElseGet(() => { throw new Error('Authentication required'); });
        const { projectId, formId, limit = 100 } = query;

        if (!projectId || !formId) {
            throw new Error('projectId and formId are required');
        }

        // Get form
        const form = await Forms.getByProjectAndXmlFormId(parseInt(projectId), formId)
            .then(getOrNotFound);

        const photos = await PhotoValidations.getPendingPhotos(form.id, parseInt(limit));

        return {
            projectId,
            formId,
            count: photos.length,
            photos: photos.map(photo => ({
                id: photo.id,
                submissionDefId: photo.submissionDefId,
                instanceId: photo.instanceId,
                attachmentName: photo.attachmentName,
                submittedValue: photo.submittedValue,
                validationCount: photo.validationCount,
                status: photo.status,
                submittedAt: photo.submittedAt
            }))
        };
    }));

    // Force-validate photos (for testing - bypasses game)
    service.post('/validations/admin/force-validate', endpoint(async ({ Forms, PhotoValidations, Audits }, { auth, query }) => {
        const actor = auth.actor.orElseGet(() => { throw new Error('Authentication required'); });
        const { projectId, formId, limit = 100 } = query;

        if (!projectId || !formId) {
            throw new Error('projectId and formId are required');
        }

        // Get form
        const form = await Forms.getByProjectAndXmlFormId(parseInt(projectId), formId, Form.PublishedVersion, Form.WithoutXml, QueryOptions.none)
            .then(getOrNotFound);

        // Force-validate pending photos
        const result = await PhotoValidations.adminForceValidate(form.id, parseInt(limit));

        // Log audit
        await Audits.log(actor, 'validation.admin-force-validate', null, {
            formId: form.id,
            photosValidated: result.updated
        });

        return {
            success: true,
            validated: result.updated,
            message: `Force-validated ${result.updated} photos (bypassed game for testing)`
        };
    }));

};
