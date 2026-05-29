~setupSweeps = {
    var sweepFxBus = Bus.audio(s, 2);

    SynthDef(\sweep, { |out = 0, dur = 6, amp = 0.2,
                       freqStart = 200, freqEnd = 8000, rq = 0.02|
        var noise   = WhiteNoise.ar();
        var freqEnv = EnvGen.kr(Env([freqStart, freqEnd], [dur], \exp));
        var ampEnv  = EnvGen.kr(
            Env([0, 1, 1, 0], [dur * 0.08, dur * 0.84, dur * 0.08], \sine),
            doneAction: 2
        );
        var filtered = BPF.ar(noise, freqEnv, rq) * 3;
        var sig = filtered * ampEnv * amp;
        Out.ar(out, sig ! 2);
    }).add;

    SynthDef(\sweepFx, { |in, out = 0, fbAmt = 0.95|
        var dry       = In.ar(in, 2);
        var delayTime = LFNoise2.kr(0.05).range(0.20, 0.60);
        var fb        = LocalIn.ar(2);
        var delayed   = DelayC.ar(dry + (fb * fbAmt), 1.0, delayTime);
        var wet       = dry + (delayed * 0.7);
        var verbed    = FreeVerb.ar(wet, mix: 0.3, room: 0.8, damp: 0.5);
        LocalOut.ar(LeakDC.ar(delayed).tanh);
        Out.ar(out, verbed);
    }).add;

    s.sync;

    Synth(\sweepFx, [\in, sweepFxBus, \out, 0], ~fxGroup);

    Tdef(\sweepSpawner, {
        rrand(15.0, 60.0).wait;
        loop {
            var sweepUp   = 0.5.coin;
            var freqLow   = exprand(80.0, 400.0);
            var freqHigh  = exprand(2000.0, 8000.0);
            var freqStart = if(sweepUp) { freqLow } { freqHigh };
            var freqEnd   = if(sweepUp) { freqHigh } { freqLow };

            Synth(\sweep, [
                \dur,       exprand(0.4, 12.0),
                \amp,       rrand(0.05, 0.10),
                \freqStart, freqStart,
                \freqEnd,   freqEnd,
                \rq,        rrand(0.01, 0.04),
                \out,       sweepFxBus
            ], ~voiceGroup);

            rrand(60.0, 300.0).wait;
        }
    }).play;
};
