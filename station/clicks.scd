~setupClicks = {
    var clickFxBus = Bus.audio(s, 2);

    SynthDef(\clickBurst, { |out = 0, dur = 1.5, amp = 0.2,
                            rateStart = 2, rateEnd = 80, rateCurve = 4,
                            pitchStart = 800, pitchEnd = 5000|
        var rateEnv  = EnvGen.kr(Env([rateStart, rateEnd], [dur], rateCurve));
        var pitchEnv = EnvGen.kr(Env([pitchStart, pitchEnd], [dur], 3));
        var ampEnv   = EnvGen.kr(
            Env([0, 1, 1, 0], [dur * 0.3, dur * 0.4, dur * 0.3], \sine),
            doneAction: 2
        );

        var trig     = Impulse.ar(rateEnv);
        var ringTime = TRand.ar(0.01, 0.05, trig);
        var click    = Ringz.ar(trig, pitchEnv, ringTime, 0.5);
        var panned   = Pan2.ar(click, LFNoise0.ar(rateEnv).range(-0.7, 0.7));

        Out.ar(out, panned * ampEnv * amp);
    }).add;

    SynthDef(\clickFx, { |in, out = 0, preDelay = 0.06|
        var dry        = In.ar(in, 2);
        var delayTime  = LFNoise2.kr(0.06).range(0.04, 0.09);
        var fbAmt      = 0.88;
        var fb         = LocalIn.ar(2);
        var delayed    = DelayC.ar(dry + (fb * fbAmt), 0.3, delayTime);
        var wet        = dry + (delayed * 0.7);
        var verbWet    = FreeVerb.ar(wet, mix: 1.0, room: 0.6, damp: 0.6);
        var preDelayed = DelayN.ar(verbWet, 0.2, preDelay);
        var verbed     = (wet * 0.75) + (preDelayed * 0.25);
        LocalOut.ar(LeakDC.ar(delayed).tanh);
        Out.ar(out, verbed * (1 - (In.kr(~sidechainBus, 1) * 0.13)));
    }).add;

    s.sync;

    Synth(\clickFx, [\in, clickFxBus, \out, 0], ~fxGroup);

    Tdef(\clickBurstSpawner, {
        rrand(20.0, 60.0).wait;
        loop {
            var rateUp     = 0.5.coin;
            var ratePeak   = exprand(15.0, 100.0);
            var rateStart  = if(rateUp) { rrand(1.0, 5.0) } { ratePeak };
            var rateEnd    = if(rateUp) { ratePeak } { 0 };
            var rateCurve  = if(rateUp) { 4 } { -2 };
            var pitchUp    = 0.7.coin;
            var pitchLow   = exprand(400.0, 1500.0);
            var pitchHigh  = exprand(2500.0, 6000.0);
            var pitchStart = if(pitchUp) { pitchLow } { pitchHigh };
            var pitchEnd   = if(pitchUp) { pitchHigh } { pitchLow };

            Synth(\clickBurst, [
                \dur,        rrand(1.0, 2.0),
                \amp,        rrand(0.15, 0.25),
                \rateStart,  rateStart,
                \rateEnd,    rateEnd,
                \rateCurve,  rateCurve,
                \pitchStart, pitchStart,
                \pitchEnd,   pitchEnd,
                \out,        clickFxBus
            ], ~voiceGroup);

            rrand(240.0, 480.0).wait;
        }
    }).play;
};
