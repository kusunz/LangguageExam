
const http = require('http');
// server.js is expected to be in the same directory
const app = require('./server');
const db = require('./db');

async function runTest() {
    console.log('--- STARTING V2 AUTO TEST ---');

    // 1. Wait for DB Init (Mocking wait or checking db pool)
    // server.js starts db init on load. We give it a moment or check db.pool.
    // Actually db.initDb returns a promise but server.js doesn't export the promise.
    // We can check db.query to see if it works, or just wait.
    console.log('Waiting for DB initialization...');
    await new Promise(r => setTimeout(r, 2000));

    // 2. Start Server
    const server = http.createServer(app);
    // use random port
    const PORT = 0;

    await new Promise(r => server.listen(PORT, r));
    const port = server.address().port;
    const baseUrl = `http://localhost:${port}`;
    console.log(`Test Server running on ${baseUrl}`);

    try {
        // 3. Test /api/exam/start
        console.log('\n[1] Testing POST /api/exam/start...');
        const startRes = await fetch(`${baseUrl}/api/exam/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                examSpec: {
                    exam_id: 'jlpt_base_N2',
                    // Minimal spec to pass validation if needed, or rely on server loading defaults?
                    // Server expects examSpec object. 
                    // We should provide enough info.
                    display_name_vi: 'JLPT N2 (Test)',
                    level: 'N2',
                    language: 'ja-JP',
                    groups: [{ group_id: 'test_group', title_vi: 'Test Group', mondai_slots: [] }], // Minimal or full?
                    // Actually V2 Start logic uses "ensurePoolSnapshot" which uses "examSpec" to generate content?
                    // OR V2 Start logic loads blueprint.
                    // Server.js: "const level = examSpec.level || examSpec.default_level;"
                    // "ensurePoolSnapshot(examSpec, level, ...)"
                    // "buildExamBlueprint" uses examSpec.groups structure.

                    // To be safe, we should use a realistic structure or rely on server having defaults?
                    // The "ExamLoader" on frontend builds the spec.
                    // Let's pass a minimal but valid structure.
                    groups: [
                        {
                            group_id: 'vocab',
                            title_vi: 'Từ vựng (Test)',
                            mondai: [
                                { mondai_id: 'M1', title_vi: 'Hán tự', count_official: 2, types: ['kanji_reading'] }
                            ]
                        }
                    ],
                    official_time_limits_sec: { overall_time_sec: 1000, groups: [] },
                    modes: { standard: { question_scale: 1, time_scale: 1 } }
                },
                mode: 'standard'
            })
        });

        if (!startRes.ok) {
            const txt = await startRes.text();
            throw new Error(`/start failed: ${startRes.status} ${txt}`);
        }

        const startData = await startRes.json();
        console.log('Start Response OK. InstanceKey:', startData.instanceKey);
        console.log('First Chunk Items:', startData.mondai ? startData.mondai.length : 0);

        if (!startData.instanceKey) throw new Error('No instanceKey returned');

        // 4. Test /api/exam/chunk
        console.log('\n[2] Testing POST /api/exam/chunk...');
        const chunkRes = await fetch(`${baseUrl}/api/exam/chunk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instanceKey: startData.instanceKey,
                want: { group_id: 'vocab', want_count: 2 }
            })
        });

        if (!chunkRes.ok) {
            throw new Error(`/chunk failed: ${chunkRes.status}`);
        }

        const chunkData = await chunkRes.json();
        console.log('Chunk Response OK. Items:', chunkData.chunk ? chunkData.chunk.length : 0);
        console.log('Done flag:', chunkData.done);

        // 5. Test /api/exam/quickgrade
        console.log('\n[3] Testing POST /api/exam/quickgrade...');
        // Create dummy answers
        const answers = {};
        if (startData.mondai && startData.mondai.length > 0) {
            // Just pick 0 for everything
            startData.mondai.forEach(m => {
                if (m.items) m.items.forEach(i => answers[i.id] = 0);
            });
        }

        const gradeRes = await fetch(`${baseUrl}/api/exam/quickgrade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instanceKey: startData.instanceKey,
                answers: answers
            })
        });

        if (!gradeRes.ok) {
            throw new Error(`/quickgrade failed: ${gradeRes.status}`);
        }

        const gradeData = await gradeRes.json();
        console.log('Quickgrade Response OK.');
        console.log('Score Summary:', gradeData.score_summary);

        console.log('\n--- TEST SUCCESS ---');

    } catch (err) {
        console.error('\n--- TEST FAILED ---');
        console.error(err);
        process.exit(1);
    } finally {
        server.close();
        // Close DB pool if exported
        if (db.pool) await db.pool.end();
    }
}

runTest();
