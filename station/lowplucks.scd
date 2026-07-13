~setupLowPlucks = {
    var lowPluckFxBus = Bus.audio(s, 2);

    // Low-register percussive sine. Same pure-sine voice as swells/plucks, but
    // a short percussive envelope so it reads as a stab rather than a pad.
    SynthDef(\lowPluck, { |freq = 300, amp = 0.06, atk = 0.005, rel = 0.5, out = 0|
        var env = EnvGen.kr(Env.perc(atk, rel, 1, -4), doneAction: 2);
        var sig = SinOsc.ar(freq) * env * amp;
        Out.ar(out, sig ! 2);
    }).add;

    // Delay with EXTERNALLY-DRIVEN feedback. The orchestrator (\lowPluckSpawner)
    // sweeps `fb` across each cycle: a "catch" level (~0.9) while a burst rings,
    // then PAST 1.0 during the pause so the loop regenerates and swells louder,
    // then back down so it recedes. `fbLag` smooths each move so feedback glides
    // rather than jumps. The tanh in the feedback path keeps fb>1 from truly
    // exploding — it saturates into a gritty bloom instead — and the output
    // Limiter protects the stream from the peaks.
    SynthDef(\lowPluckFx, { |in, out = 0, preDelay = 0.06, fb = 0.85, fbLag = 0.5|
        var dry        = In.ar(in, 2);
        var delayTime  = LFNoise2.kr(0.015).range(0.08, 0.22);
        var fbAmt      = Lag.kr(fb, fbLag);
        var fbsig      = LocalIn.ar(2);
        var delayed    = DelayC.ar(dry + (fbsig * fbAmt), 0.5, delayTime);
        var mixed      = dry + (delayed * 0.55);
        var verbWet    = FreeVerb.ar(mixed, mix: 1.0, room: 0.6, damp: 0.5);
        var preDelayed = DelayN.ar(verbWet, 0.2, preDelay);
        var wet        = (mixed * 0.7) + (preDelayed * 0.3);
        var sig        = wet * (1 - (In.kr(~sidechainBus, 1) * 0.3));
        LocalOut.ar(LeakDC.ar(delayed).tanh);
        Out.ar(out, Limiter.ar(sig, 0.95));
    }).add;

    s.sync;

    // Global handle so the swell<->lowPluck switcher in piece.scd can ramp the
    // feedback down when it switches away (a mid-bloom stop would otherwise drone).
    ~lowPluckFxSynth = Synth(\lowPluckFx, [
        \in, lowPluckFxBus,
        \out, ~masterBus,
        \fb, 0.85
    ], ~fxGroup);

    // Burst -> bloom cycle (replaces the old continuous density spawner):
    //   1. BURST   ~10 hits in 1-2s (single random notes on the fallback path,
    //              or the whole spectrum as a chord when a compound is loaded);
    //              feedback snaps to a high "catch" level so the delay grabs them
    //              at once, then they slowly fade.
    //   2. FADE    a couple seconds letting those echoes start to die back.
    //   3. BLOOM   push feedback past 100% so the loop regenerates and the sound
    //              builds louder (tanh saturates it instead of exploding).
    //   4. SETTLE  drop feedback back to a normal-delay level (~92-96%); the
    //              bloom recedes and rings on before the next burst.
    // Pause (fade+bloom+settle) is ~8-20s, and every stage is randomized.
    Tdef(\lowPluckSpawner, {
        var spawnNote = { |freq, amp, rel|
            Synth(\lowPluck, [
                \freq, freq,
                \amp,  amp,
                \atk,  rrand(0.003, 0.01),
                \rel,  rel,
                \out,  lowPluckFxBus
            ], ~voiceGroup);
        };
        loop {
            var nNotes   = rrand(8, 13);
            var burstDur = rrand(1.0, 2.0);
            var fadeT    = rrand(1.5, 3.5);
            var bloomT   = rrand(4.0, 9.0);
            var settleT  = rrand(2.0, 8.0);

            // --- 1. BURST: 8-13 hits. Feedback snaps straight to a high "catch"
            // level (fast lag) so the delay grabs the burst immediately. ---
            ~lowPluckFxSynth.set(\fb, rrand(0.85, 0.9), \fbLag, 0.05);
            nNotes.do {
                var rel = rrand(0.3, 0.8);
                if(~currentCompound.freqs.notNil and: { ~currentCompound.freqs.notEmpty }) {
                    // Spectrum path: each hit is the WHOLE spectrum played as a
                    // chord, transposed so its base lands on a random pitch ->
                    // 8-13 random chords. (Load a compound via the webhook.)
                    var transpose = rrand(0.5, 1.5);
                    ~currentCompound.freqs.do { |freq, i|
                        spawnNote.(
                            freq * transpose,
                            rrand(0.03, 0.06) * ~currentCompound.amps[i],
                            rel
                        );
                    };
                } {
                    // Fallback path: a single random low note per hit.
                    spawnNote.(exprand(200.0, 1000.0), rrand(0.03, 0.06), rel);
                };
                ((burstDur / nNotes) * rrand(0.6, 1.4)).wait;
            };

            // --- 2. FADE: delay catches the burst and slowly fades ---
            fadeT.wait;

            // --- 3. BLOOM: feedback past 100% -> regenerates, builds louder.
            // Ramp takes a chunk of bloomT so it climbs rather than slams. ---
            ~lowPluckFxSynth.set(\fb, rrand(1.05, 1.12), \fbLag, bloomT * rrand(0.3, 0.5));
            bloomT.wait;

            // --- 4. SETTLE: back to a normal-delay level (~92-96%) -> the bloom
            // recedes and rings on normally before the next burst. ---
            ~lowPluckFxSynth.set(\fb, rrand(0.92, 0.96), \fbLag, settleT * rrand(0.25, 0.45));
            settleT.wait;
        }
    }).play;
};
