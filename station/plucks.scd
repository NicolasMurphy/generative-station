~setupPlucks = {
    var pluckFxBus = Bus.audio(s, 2);

    SynthDef(\pluck, { |freq = 1500, amp = 0.12, atk = 0.005, rel = 0.25, pan = 0, out = 0|
        var env = EnvGen.kr(Env.perc(atk, rel, 1, -4), doneAction: 2);
        var sig = SinOsc.ar(freq) * env * amp;
        Out.ar(out, ~place.(sig, pan));
    }).add;

    SynthDef(\pluckFx, { |in, out = 0, preDelay = 0.06|
        var dry        = In.ar(in, 2);
        var delayTime  = LFNoise2.kr(0.05).range(0.05, 0.12);
        var fbAmt      = 0.93;
        var fb         = LocalIn.ar(2);
        var delayed    = DelayC.ar(dry + (fb * fbAmt), 0.3, delayTime);
        var wet        = dry + (delayed * 0.6);
        var verbWet    = FreeVerb.ar(wet, mix: 1.0, room: 0.7, damp: 0.5);
        var preDelayed = DelayN.ar(verbWet, 0.2, preDelay);
        var verbed     = (wet * 0.7) + (preDelayed * 0.3);
        LocalOut.ar(LeakDC.ar(delayed).tanh);
        Out.ar(out, verbed * (1 - (In.kr(~sidechainBus, 1) * 0.2)));
    }).add;

    s.sync;

    Synth(\pluckFx, [\in, pluckFxBus, \out, ~masterBus], ~fxGroup);

    Tdef(\pluckSpawner, {
        loop {
            ~spawn.(\plucks, {
                if(~currentCompound.freqs.notNil and: { ~currentCompound.freqs.notEmpty }) {
                    // Chord mode: spawn one pluck per compound peak, all at once.
                    // Random per-spawn transpose preserves intervallic shape while
                    // varying pitch height each cycle. Each pluck's amp is the base
                    // amp scaled by the compound's normalized amplitude — most
                    // spectra have a few prominent peaks plus a noise floor, so
                    // total energy stays reasonable without explicit N-normalization.
                    var transpose = rrand(1.0, 2.0) * ~register.(\plucks);
                    var ampScale = rrand(0.012, 0.03);
                    var atk = rrand(0.003, 0.01);
                    var rel = rrand(0.15, 0.4);
                    ~currentCompound.freqs.do { |freq, i|
                        Synth(\pluck, [
                            \freq, freq * transpose,
                            \amp,  ampScale * ~currentCompound.amps[i],
                            \atk,  atk,
                            \rel,  rel,
                            \pan,  rrand(-0.8, 0.8),
                            \out,  pluckFxBus
                        ], ~voiceGroup);
                    };
                } {
                    // No compound loaded — original random pluck behavior.
                    Synth(\pluck, [
                        \freq, exprand(1000.0, 3000.0) * ~register.(\plucks),
                        \amp,  rrand(0.012, 0.03),
                        \atk,  rrand(0.003, 0.01),
                        \rel,  rrand(0.15, 0.4),
                        \pan,  rrand(-0.8, 0.8),
                        \out,  pluckFxBus
                    ], ~voiceGroup);
                };
            });
            (rrand(10.0, 30.0) * ~pace.(\plucks)).wait;
        }
    }).play;

    // A rare event, once every hour or three: the spectrum played as a run
    // of plucks from its lowest peak to its highest, crossing from left to
    // right (a harmonic series when no compound is loaded). The same pluck
    // through the same delay as always, only in order for once.
    Tdef(\pluckCascade, {
        loop {
            var freqs = [], amps = [];
            (rrand(60.0, 180.0) * 60).wait;
            try {
                if(~currentCompound.freqs.notNil and: { ~currentCompound.freqs.notEmpty }) {
                    // the sixteen strongest peaks at most, low to high
                    var keep = ~currentCompound.amps.order.reverse.keep(16);
                    keep = keep.sort { |a, b| ~currentCompound.freqs[a] < ~currentCompound.freqs[b] };
                    freqs = ~currentCompound.freqs[keep] * rrand(1.0, 2.0) * ~register.(\plucks);
                    // quiet peaks are lifted, or most of the run would be inaudible
                    amps = ~currentCompound.amps[keep] ** 0.3;
                } {
                    freqs = exprand(110.0, 220.0) * ~register.(\plucks) * (2..13);
                    amps = 1 ! 12;
                };
            } { |err|
                ("[plucks] cascade skipped: " ++ err.errorString).postln;
            };
            if(freqs.notEmpty) {
                var gap = rrand(0.09, 0.16);
                var level = rrand(0.02, 0.032);
                ("[plucks] cascade of " ++ freqs.size ++ " notes").postln;
                freqs.do { |freq, i|
                    ~spawn.(\plucks, {
                        Synth(\pluck, [
                            \freq, freq,
                            \amp,  level * amps[i],
                            \atk,  0.004,
                            \rel,  rrand(0.2, 0.4),
                            \pan,  i.linlin(0, (freqs.size - 1).max(1), -0.8, 0.8),
                            \out,  pluckFxBus
                        ], ~voiceGroup);
                    });
                    (gap * (0.97 ** i)).wait;  // gathering a little speed
                };
            };
        }
    }).play;
};
