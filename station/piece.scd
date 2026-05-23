(
s = Server.default;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 0;
s.options.sampleRate = 48000;
s.options.blockSize = 64;
s.options.memSize = 8192 * 4;

s.waitForBoot({
    var fxBus, pluckFxBus, voiceGroup, fxGroup;

    fxBus = Bus.audio(s, 2);
    pluckFxBus = Bus.audio(s, 2);

    SynthDef(\swellSine, { |freq = 440, amp = 0.04, atk = 3, rel = 5, out = 0|
        var env = EnvGen.kr(
            Env([0, 1, 0], [atk, rel], \sine),
            doneAction: 2
        );
        var sig = SinOsc.ar(freq) * env * amp;
        Out.ar(out, sig ! 2);
    }).add;

    SynthDef(\pluck, { |freq = 1500, amp = 0.12, atk = 0.005, rel = 0.25, out = 0|
        var env = EnvGen.kr(Env.perc(atk, rel, 1, -4), doneAction: 2);
        var sig = SinOsc.ar(freq) * env * amp;
        Out.ar(out, sig ! 2);
    }).add;

    SynthDef(\fx, { |in, out = 0|
        var dry       = In.ar(in, 2);
        var delayTime = LFNoise2.kr(0.1).range(0.15, 0.55);
        var baseFb    = LFNoise2.kr(0.08).range(0.30, 0.50);
        var jumpTrig  = Dust.kr(0.025);
        var jumpEnv   = EnvGen.kr(Env([0, 0.45, 0], [0.4, 2.0], \sine), jumpTrig);
        var fbAmt     = (baseFb + jumpEnv).clip(0, 0.95);
        var fb        = LocalIn.ar(2);
        var delayed   = DelayC.ar(dry + (fb * fbAmt), 1.0, delayTime);
        var mixed     = dry + (delayed * 0.45);
        var wet = FreeVerb.ar(
            mixed,
            mix:  LFNoise2.kr(0.07).range(0.35, 0.7),
            room: LFNoise2.kr(0.05).range(0.6, 0.9),
            damp: LFNoise2.kr(0.05).range(0.2, 0.6)
        );
        LocalOut.ar(LeakDC.ar(delayed).tanh);
        Out.ar(out, wet);
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

    voiceGroup = Group.new;
    fxGroup = Group.after(voiceGroup);
    Synth(\fx,      [\in, fxBus,      \out, 0], fxGroup);
    Synth(\pluckFx, [\in, pluckFxBus, \out, 0], fxGroup);

    Tdef(\spawner, {
        var start = thisThread.seconds;
        loop {
            var elapsed = thisThread.seconds - start;
            var density = sin(elapsed * 2pi / 240) * 0.5 + 0.5;
            var waitMin = 0.3 + ((1 - density) * 2.5);
            var waitMax = 0.8 + ((1 - density) * 6.0);
            Synth(\swellSine, [
                \freq, exprand(200.0, 1000.0),
                \amp,  rrand(0.02, 0.05),
                \atk,  rrand(2.0, 6.0),
                \rel,  rrand(3.0, 8.0),
                \out,  fxBus
            ], voiceGroup);
            rrand(waitMin, waitMax).wait;
        }
    }).play;

    Tdef(\pluckSpawner, {
        loop {
            Synth(\pluck, [
                \freq, exprand(1000.0, 3000.0),
                \amp,  rrand(0.012, 0.03),
                \atk,  rrand(0.003, 0.01),
                \rel,  rrand(0.15, 0.4),
                \out,  pluckFxBus
            ], voiceGroup);
            rrand(10.0, 30.0).wait;
        }
    }).play;

    "[piece] sine cloud + sparse plucks running".postln;
});
)
