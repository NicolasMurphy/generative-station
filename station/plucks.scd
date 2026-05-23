~setupPlucks = {
    var pluckFxBus = Bus.audio(s, 2);

    SynthDef(\pluck, { |freq = 1500, amp = 0.12, atk = 0.005, rel = 0.25, out = 0|
        var env = EnvGen.kr(Env.perc(atk, rel, 1, -4), doneAction: 2);
        var sig = SinOsc.ar(freq) * env * amp;
        Out.ar(out, sig ! 2);
    }).add;

    SynthDef(\pluckFx, { |in, out = 0|
        var dry       = In.ar(in, 2);
        var delayTime = LFNoise2.kr(0.05).range(0.05, 0.12);
        var fbAmt     = 0.93;
        var fb        = LocalIn.ar(2);
        var delayed   = DelayC.ar(dry + (fb * fbAmt), 0.3, delayTime);
        var wet       = dry + (delayed * 0.6);
        var verbed    = FreeVerb.ar(wet, mix: 0.3, room: 0.7, damp: 0.5);
        LocalOut.ar(LeakDC.ar(delayed).tanh);
        Out.ar(out, verbed);
    }).add;

    s.sync;

    Synth(\pluckFx, [\in, pluckFxBus, \out, 0], ~fxGroup);

    Tdef(\pluckSpawner, {
        loop {
            if(~currentCompound.freqs.notNil and: { ~currentCompound.freqs.notEmpty }) {
                // Chord mode: spawn one pluck per compound peak, all at once.
                // Random per-spawn transpose preserves intervallic shape while
                // varying pitch height each cycle. Amp scaled by 1/sqrt(N) so
                // dense spectra don't blow out vs sparse ones.
                var transpose = rrand(1.0, 2.0);
                var n = ~currentCompound.freqs.size;
                var ampScale = rrand(0.012, 0.03) / n.sqrt;
                var atk = rrand(0.003, 0.01);
                var rel = rrand(0.15, 0.4);
                ~currentCompound.freqs.do { |freq, i|
                    Synth(\pluck, [
                        \freq, freq * transpose,
                        \amp,  ampScale * ~currentCompound.amps[i],
                        \atk,  atk,
                        \rel,  rel,
                        \out,  pluckFxBus
                    ], ~voiceGroup);
                };
            } {
                // No compound loaded — original random pluck behavior.
                Synth(\pluck, [
                    \freq, exprand(1000.0, 3000.0),
                    \amp,  rrand(0.012, 0.03),
                    \atk,  rrand(0.003, 0.01),
                    \rel,  rrand(0.15, 0.4),
                    \out,  pluckFxBus
                ], ~voiceGroup);
            };
            rrand(10.0, 30.0).wait;
        }
    }).play;
};
