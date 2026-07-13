~setupPercussion = {
    var percussionBus = Bus.audio(s, 2);

    // Quantized abstract percussion generated entirely inside scsynth. Every
    // sixteenth selects exactly one gesture, so the source layers never stack.
    SynthDef(\percussionTexture, { |out = 0, bpm = 128, amp = 0.12,
                                    active = 0, fadeTime = 5|
        var freqs, baseRate, fastRate, fastTrig, hitType, stepInBar;
        var activeGain;
        var fillCycleStep, fillWindow, fillHitTrig, fillStep, fillKickPattern;
        var fillFlip, fillKickTrig, fillSnareTrig;
        var kickProbability, kickTrig, gestureGate, kickFreq, kickEnv, kickClick, kick;
        var snareStepGate, snareTrig, snareEnv, snareNoise, snareBody, snare;
        var ghostProbability, ghostTrig, ghostEnv, ghostNoise, ghostBody, ghost;
        var kickBurstStart, kickBurstControlTrig, kickBurstChoice, kickBurstSteps, kickBurstRate;
        var kickBurstWindow, kickPlayTrig;
        var snareBurstStart, snareBurstControlTrig, snareBurstChoice, snareBurstSteps, snareBurstRate;
        var snareBurstWindow, snarePlayTrig, drumBurstActive;
        var pinTrig, pinControlTrig, pinIndex, pinFreq, pinRatio, pinDecay, pinEnv;
        var pinTone, pinNoise, pin;
        var crackTrig, crackRate, crackWidth, crackEnv, crackNoise, crack;
        var scrapeTrig, scrapeFreq, scrapeRq, scrapeEnv, scrape;
        var microTrig, microFreq, microRq, microEnv, micro;
        var burstStart, burstChoice, burstRate, burstWindow, normalGate;
        var burstTrig, burstFreq, burstRq, burstEnv, burst;

        freqs = NamedControl.kr(\freqs, [
            3200, 3900, 4700, 5600, 6500, 7400, 8400, 9500
        ]);
        baseRate = bpm / 60;
        activeGain = Lag.kr(active, fadeTime);
        fastRate = baseRate * 4;
        fastTrig = Impulse.ar(fastRate);
        hitType = TIRand.ar(0, 3, fastTrig);
        stepInBar = PulseCount.ar(fastTrig) % 16;

        // One bar of drum-only material every 16 bars. The core pattern is
        // SKSKSSKKSSSSKKKK, with occasional per-step inversions.
        fillCycleStep = PulseCount.ar(fastTrig) % 256;
        fillWindow = fillCycleStep > 239.5;
        fillHitTrig = fastTrig * fillWindow;
        fillStep = fillCycleStep % 16;
        fillKickPattern = (
            ((fillStep > 0.5) * (fillStep < 1.5))
            + ((fillStep > 2.5) * (fillStep < 3.5))
            + ((fillStep > 5.5) * (fillStep < 7.5))
            + ((fillStep > 11.5) * (fillStep < 15.5))
        ).clip(0, 1);
        fillFlip = CoinGate.ar(0.15, fillHitTrig);
        fillKickTrig = fillHitTrig * (
            (fillKickPattern * (1 - fillFlip))
            + ((1 - fillKickPattern) * fillFlip)
        ).clip(0, 1);
        fillSnareTrig = fillHitTrig * (1 - fillKickTrig);

        // Bursts always begin on a sixteenth, then temporarily replace the
        // normal gesture stream with either 32nd- or 64th-note noise hits.
        burstStart = CoinGate.ar(0.04, fastTrig * (1 - fillWindow));
        burstChoice = TIRand.ar(0, 1, burstStart);
        burstRate = baseRate * (8 + (burstChoice * 8));
        burstWindow = Decay2.ar(
            burstStart,
            0.001,
            TRand.ar(0.07, 0.24, burstStart)
        );
        normalGate = (burstWindow < 0.02) * (1 - burstStart);
        burstTrig = (
            (Impulse.ar(burstRate) * (burstWindow > 0.02)) + burstStart
        ).clip(0, 1);
        burstFreq = TExpRand.ar(3500, 14500, burstTrig);
        burstRq = TRand.ar(0.035, 0.32, burstTrig);
        burstEnv = Decay2.ar(
            burstTrig,
            0.0005,
            TRand.ar(0.004, 0.018, burstTrig)
        );
        burst = BPF.ar(WhiteNoise.ar, burstFreq, burstRq)
            * burstEnv * (1 - fillWindow);
        burst = Pan2.ar(burst, TRand.ar(-1.0, 1.0, burstTrig), 1.1);

        // Weighted kick map: beat 1 remains the strongest anchor, while a few
        // lower-probability placements keep successive bars from repeating.
        kickProbability = (
            (((stepInBar > 0.5) * (stepInBar < 1.5)) * 0.7)
            + (((stepInBar > 2.5) * (stepInBar < 3.5)) * 0.5)
            + (((stepInBar > 3.5) * (stepInBar < 4.5)) * 0.2)
            + (((stepInBar > 6.5) * (stepInBar < 7.5)) * 0.5)
            + (((stepInBar > 10.5) * (stepInBar < 11.5)) * 0.15)
            + (((stepInBar > 14.5) * (stepInBar < 15.5)) * 0.5)
        ).clip(0, 1);
        kickTrig = (
            (CoinGate.ar(kickProbability, fastTrig * normalGate)
                * (1 - fillWindow))
            + fillKickTrig
        ).clip(0, 1);

        snareStepGate = (
            ((stepInBar > 4.5) * (stepInBar < 5.5))
            + ((stepInBar > 12.5) * (stepInBar < 13.5))
        ).clip(0, 1);
        snareTrig = (
            (CoinGate.ar(0.9, fastTrig * normalGate * snareStepGate)
                * (1 - fillWindow))
            + fillSnareTrig
        ).clip(0, 1);

        kickBurstStart = CoinGate.ar(0.08, kickTrig * (1 - fillWindow));
        kickBurstControlTrig = T2K.kr(kickBurstStart);
        kickBurstChoice = TIRand.kr(0, 1, kickBurstControlTrig);
        kickBurstSteps = TIRand.kr(2, 4, kickBurstControlTrig);
        kickBurstRate = baseRate * (4 + (kickBurstChoice * 4));
        kickBurstWindow = Trig1.ar(
            kickBurstStart,
            kickBurstSteps / fastRate
        );
        kickPlayTrig = (
            kickTrig
            + (Impulse.ar(kickBurstRate) * kickBurstWindow
                * normalGate * (1 - fillWindow))
        ).clip(0, 1);

        snareBurstStart = CoinGate.ar(0.1, snareTrig * (1 - fillWindow));
        snareBurstControlTrig = T2K.kr(snareBurstStart);
        snareBurstChoice = TIRand.kr(0, 1, snareBurstControlTrig);
        snareBurstSteps = TIRand.kr(2, 4, snareBurstControlTrig);
        snareBurstRate = baseRate * (8 + (snareBurstChoice * 8));
        snareBurstWindow = Trig1.ar(
            snareBurstStart,
            snareBurstSteps / fastRate
        );
        // Kick wins any exact collision, including overlapping ratchets.
        snarePlayTrig = (
            snareTrig
            + (Impulse.ar(snareBurstRate) * snareBurstWindow
                * normalGate * (1 - fillWindow))
        ).clip(0, 1) * (1 - kickPlayTrig);

        drumBurstActive = (kickBurstWindow + snareBurstWindow).clip(0, 1);

        // Quiet grace notes fill selected gaps around the backbeats. They
        // always yield to full drum hits and active ratchets.
        ghostProbability = (
            (((stepInBar > 1.5) * (stepInBar < 2.5)) * 0.18)
            + (((stepInBar > 3.5) * (stepInBar < 4.5)) * 0.12)
            + (((stepInBar > 7.5) * (stepInBar < 8.5)) * 0.22)
            + (((stepInBar > 9.5) * (stepInBar < 10.5)) * 0.14)
            + (((stepInBar > 11.5) * (stepInBar < 12.5)) * 0.18)
            + ((stepInBar < 0.5) * 0.12)
        ).clip(0, 1);
        ghostTrig = CoinGate.ar(
            ghostProbability,
            fastTrig
                * normalGate
                * (1 - fillWindow)
                * (1 - drumBurstActive)
                * (1 - kickPlayTrig)
                * (1 - snarePlayTrig)
        );

        gestureGate = normalGate
            * (1 - fillWindow)
            * (1 - (kickTrig + snareTrig).clip(0, 1))
            * (1 - drumBurstActive)
            * (1 - ghostTrig);

        kickFreq = EnvGen.ar(
            Env([125, 46], [0.09], \exp),
            kickPlayTrig
        );
        kickEnv = Decay2.ar(kickPlayTrig, 0.002, 0.24);
        kickClick = HPF.ar(WhiteNoise.ar, 3500)
            * Decay2.ar(kickPlayTrig, 0.001, 0.012);
        kick = (SinOsc.ar(kickFreq) * kickEnv * 1.2)
            + (SinOsc.ar(kickFreq * 2.03) * kickEnv * 0.32)
            + (kickClick * 0.22);
        kick = Pan2.ar((kick * 5).tanh, 0, 0.72);

        snareEnv = Decay2.ar(snarePlayTrig, 0.001, 0.11);
        snareNoise = HPF.ar(WhiteNoise.ar, 1400) * snareEnv;
        snareBody = Mix(Ringz.ar(snarePlayTrig, [185, 337], [0.07, 0.045]));
        snare = ((snareNoise * 0.85) + (snareBody * 0.18) * 2.5).tanh;
        snare = Pan2.ar(snare, 0, 0.52);

        ghostEnv = Decay2.ar(ghostTrig, 0.001, 0.055);
        ghostNoise = BPF.ar(WhiteNoise.ar, 4200, 0.55) * ghostEnv;
        ghostBody = Mix(Ringz.ar(ghostTrig, [242, 418], [0.035, 0.022]));
        ghost = (ghostNoise * 0.8) + (ghostBody * 0.08);
        ghost = Pan2.ar(ghost.softclip, TRand.ar(-0.3, 0.3, ghostTrig), 0.2);

        pinTrig = fastTrig * gestureGate * (hitType < 0.5);
        pinControlTrig = T2K.kr(pinTrig);
        pinIndex = TIRand.kr(0, 7, pinControlTrig);
        pinFreq = Select.kr(pinIndex, freqs);
        pinRatio = TRand.ar(0.72, 2.6, pinTrig);
        pinDecay = TRand.ar(0.008, 0.075, pinTrig);
        pinEnv = Decay2.ar(pinTrig, 0.001, pinDecay);
        pinTone = Ringz.ar(
            pinTrig,
            (pinFreq * pinRatio).clip(1800, 14000),
            pinDecay
        );
        pinNoise = BPF.ar(
            WhiteNoise.ar,
            pinFreq.clip(1800, 13000),
            TRand.ar(0.025, 0.35, pinTrig)
        ) * pinEnv * 3;
        pin = (pinTone * TRand.ar(0.05, 0.35, pinTrig)) + pinNoise;
        pin = Pan2.ar(pin, TRand.ar(-1.0, 1.0, pinTrig), 0.28);

        crackTrig = fastTrig * gestureGate * (hitType > 0.5) * (hitType < 1.5);
        crackRate = TExpRand.ar(25, 240, crackTrig);
        crackWidth = TRand.ar(0.03, 0.28, crackTrig);
        crackEnv = Decay2.ar(
            crackTrig,
            0.001,
            TRand.ar(0.018, 0.085, crackTrig)
        );
        crackNoise = HPF.ar(WhiteNoise.ar, 2200)
            * TRand.ar(0.3, 1.0, crackTrig);
        crack = (HPF.ar(Pulse.ar(crackRate, crackWidth), 2800) + crackNoise)
            * crackEnv;
        crack = Pan2.ar(crack, TRand.ar(-1.0, 1.0, crackTrig), 0.22);

        scrapeTrig = fastTrig * gestureGate * (hitType > 1.5) * (hitType < 2.5);
        scrapeFreq = TExpRand.ar(1800, 12500, scrapeTrig);
        scrapeRq = TRand.ar(0.025, 0.3, scrapeTrig);
        scrapeEnv = Decay2.ar(
            scrapeTrig,
            0.002,
            TRand.ar(0.025, 0.09, scrapeTrig)
        );
        scrape = BPF.ar(WhiteNoise.ar, scrapeFreq, scrapeRq) * scrapeEnv;
        scrape = Pan2.ar(scrape, TRand.ar(-1.0, 1.0, scrapeTrig), 1.1);

        microTrig = fastTrig * gestureGate * (hitType > 2.5);
        microFreq = TExpRand.ar(3200, 14000, microTrig);
        microRq = TRand.ar(0.04, 0.5, microTrig);
        microEnv = Decay2.ar(
            microTrig,
            0.001,
            TRand.ar(0.005, 0.06, microTrig)
        );
        micro = BPF.ar(WhiteNoise.ar, microFreq, microRq) * microEnv;
        micro = Pan2.ar(micro, TRand.ar(-0.85, 0.85, microTrig), 0.75);

        Out.ar(out, (
            (kick + snare + ghost + pin + crack + scrape + micro + burst) * amp
        ).softclip * activeGain);
    }).add;

    // Mostly dry. A grid-locked capture every four bars feeds one short slice
    // into the comb; the effect never introduces an off-grid trigger.
    SynthDef(\percussionOut, { |in = 0, out = 0, bpm = 128, gain = 4.0|
        var dry, grid, captureTrig, capture, combDelay, combDecay, comb, sig;

        dry = In.ar(in, 2);
        grid = Impulse.kr((bpm / 60) * 4);
        captureTrig = PulseDivider.kr(grid, 64, 63);
        capture = Decay2.kr(
            captureTrig,
            0.001,
            TRand.kr(0.035, 0.1, captureTrig)
        );
        combDelay = TExpRand.kr(0.025, 0.16, captureTrig);
        combDecay = TRand.kr(0.25, 0.8, captureTrig);
        comb = CombC.ar(dry * capture, 0.2, combDelay, combDecay);
        sig = LeakDC.ar(dry + (comb * 0.42)) * gain;
        Out.ar(out, sig);
    }).add;

    s.sync;

    Synth(\percussionOut, [
        \in, percussionBus,
        \out, ~masterBus,
        \bpm, 128,
        \gain, 4.0
    ], ~fxGroup);

    ~percussionTextureSynth = Synth(\percussionTexture, [
        \out, percussionBus,
        \bpm, 128,
        \amp, 0.12,
        \active, 0,
        \fadeTime, 5
    ], ~voiceGroup);

    ~updatePercussion = {
        var source;
        var mapped;

        source = if(~currentCompound.freqs.notNil and: {
            ~currentCompound.freqs.notEmpty
        }) {
            ~currentCompound.freqs
        } {
            [137, 233, 389, 617, 997, 1597, 2551, 4093]
        };
        mapped = Array.fill(8, { |i|
            2500 + (source.wrapAt(i).abs % 7500)
        });

        ~percussionTextureSynth.setn(\freqs, mapped);
    };

    ~updatePercussion.();

    if(~percussionWindowRoutine.notNil) {
        ~percussionWindowRoutine.stop;
    };

    ~percussionWindowRoutine = Routine({
        loop {
            var gap = rrand(10.0, 20.0) * 60;
            var window = rrand(5.0, 10.0) * 60;

            ("[percussion] silent for " ++ (gap / 60).round(0.1)
                ++ " minutes").postln;
            gap.wait;

            ("[percussion] window open for " ++ (window / 60).round(0.1)
                ++ " minutes").postln;
            ~percussionTextureSynth.set(\active, 1);
            window.wait;

            ~percussionTextureSynth.set(\active, 0);
        };
    }).play(SystemClock);

    "[percussion] scheduled windows ready @ 128 bpm".postln;
};
