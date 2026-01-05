// Copyright 2025 India Datasets Platform
// Migration: Add Photo Validations tables
// References submission_defs.id directly to avoid FK issues with composite-key tables

const up = async (db) => {
    await db.schema.createTable('photo_validations', (t) => {
        t.increments('id');

        // Reference via submission_defs.id and attachment file name
        t.integer('submissionDefId').notNull();
        t.foreign('submissionDefId').references('submission_defs.id').onDelete('CASCADE');
        t.text('attachmentName').notNull();

        t.integer('validatorId').notNull();
        t.foreign('validatorId').references('actors.id');

        t.text('expectedValue').notNull();
        t.boolean('userSelected').notNull();
        t.timestamp('createdAt').defaultTo(db.fn.now());

        t.index(['submissionDefId', 'attachmentName']);
        t.index('validatorId');
    });

    await db.schema.createTable('photo_validation_status', (t) => {
        t.increments('id');

        // Reference via submission_defs.id and attachment file name
        t.integer('submissionDefId').notNull();
        t.foreign('submissionDefId').references('submission_defs.id').onDelete('CASCADE');
        t.text('attachmentName').notNull();
        t.unique(['submissionDefId', 'attachmentName']);

        t.text('fieldName').notNull();
        t.text('submittedValue').nullable();

        t.integer('validationCount').defaultTo(0);
        t.text('consensusValue').nullable();
        t.string('status', 20).defaultTo('pending'); // pending, validated, flagged

        t.timestamp('updatedAt').defaultTo(db.fn.now());
    });
};

const down = async (db) => {
    await db.schema.dropTableIfExists('photo_validation_status');
    await db.schema.dropTableIfExists('photo_validations');
};

module.exports = { up, down };
