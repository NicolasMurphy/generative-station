(
s = Server.default;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 0;
s.options.sampleRate = 48000;
s.options.blockSize = 64;
s.options.memSize = 8192 * 4;

s.waitForBoot({
    var here = thisProcess.nowExecutingPath.dirname;

    ~voiceGroup = Group.new;
    ~fxGroup    = Group.after(~voiceGroup);
    ~masterGroup = Group.after(~fxGroup);

    // All final voice/FX outputs feed this private stereo bus. A single synth
    // in ~masterGroup applies output protection before writing to JACK.
    ~masterBus = Bus.audio(s, 2);

    // Sidechain control bus (0 = no duck, 1 = full duck). The percussion's
    // kick publishes a ducking envelope here while its window is open.
    ~sidechainBus = Bus.control(s, 1);

    SynthDef(\masterOut, { |in = 0, out = 0, gain = 1.0,
                            ceiling = 0.8, limiterDur = 0.01|
        var sig = In.ar(in, 2);
        sig = LeakDC.ar(sig);
        sig = sig * Lag.kr(gain, 0.1);
        sig = Limiter.ar(sig, ceiling, limiterDur);
        Out.ar(out, sig);
    }).add;

    s.sync;

    // Every voice spawns its notes through ~spawn.
    //  - s.bind stamps the messages s.latency ahead, so the server starts
    //    them on the block they were meant for. Sent unstamped, a message
    //    only takes effect at the start of the next JACK period, which
    //    snapped every note to an 85 ms grid (period 4096 at 48 kHz): notes
    //    asked for 134 ms apart came out 85 or 171 ms apart. The latency has
    //    to cover two periods of output latency plus the period itself;
    //    0.2 s arrived late, 0.5 s lands within a few milliseconds.
    //  - try: an error in one event is logged instead of ending the voice's
    //    loop for good (a Tdef whose loop died still reports isPlaying).
    s.latency = 0.5;
    ~spawn = { |voice, func|
        try { s.bind(func) } { |err|
            ("[" ++ voice ++ "] error, carrying on: " ++ err.errorString).postln;
        };
    };

    // Current compound, populated by /compound OSC messages from the picker
    // sidecar. Starts nil so voices fall back to their original random ranges.
    ~currentCompound = (
        name: nil,
        accession: nil,
        algorithm: nil,
        freqs: nil,
        amps: nil
    );

    // Voices spawn one synth per peak per event, so the peak count multiplies
    // the server load: a 100-peak compound overran scsynth's 1024-node limit
    // during dense swells (50 peaks peaked at 958 nodes) and notes were
    // dropped. Only the ~maxPeaks strongest peaks are voiced, and peaks more
    // than 40 dB below the strongest are skipped: they are inaudible in the
    // mix and each one still costs a synth per event.
    ~maxPeaks = 32;
    ~peakFloor = 0.01;

    // Listen for compound updates from the picker sidecar (port 57120).
    // Message: [name, accession, algorithm, nPeaks, freq1..N, amp1..N]
    // The picker re-sends the current compound periodically so that a
    // restarted station picks it up again; an unchanged message is ignored.
    OSCdef(\compound, { |msg|
        var name = msg[1].asString;
        var accession = msg[2].asString;
        var algorithm = msg[3].asString;
        var n = msg[4].asInteger;
        var freqs = msg[(5..(4+n))];
        var amps = msg[((5+n)..(4+(2*n)))];
        var floor, keep;
        if((n > 0) and: { msg != ~lastCompoundMsg }) {
            ~lastCompoundMsg = msg;
            floor = amps.maxItem * ~peakFloor;
            keep = (0..(n - 1)).select { |i| amps[i] >= floor };
            if(keep.size > ~maxPeaks) {
                // strongest first, then back into their original order
                keep = keep.sort { |a, b| amps[a] > amps[b] }.keep(~maxPeaks).sort;
            };
            ~currentCompound = (
                name: name,
                accession: accession,
                algorithm: algorithm,
                freqs: freqs[keep],
                amps: amps[keep]
            );
            if(~updatePercussion.notNil) {
                ~updatePercussion.();
            };
            ("[piece] compound: " ++ name ++ " (" ++ n ++ " peaks, "
                ++ keep.size ++ " voiced)").postln;
        };
    }, "/compound");

    (here +/+ "swells.scd").load;
    (here +/+ "lowplucks.scd").load;
    (here +/+ "plucks.scd").load;
    (here +/+ "clicks.scd").load;
    (here +/+ "sweeps.scd").load;
    (here +/+ "bass.scd").load;
    (here +/+ "percussion.scd").load;

    // A file with a syntax error does not throw when loaded. It prints the
    // error and leaves its setup function undefined, and calling nil does
    // nothing, so the piece would carry on without that voice and still
    // report itself running. Stop here instead.
    [
        \swells -> ~setupSwells, \lowplucks -> ~setupLowPlucks,
        \plucks -> ~setupPlucks, \clicks -> ~setupClicks,
        \sweeps -> ~setupSweeps, \bass -> ~setupBass,
        \percussion -> ~setupPercussion
    ].do { |voice|
        if(voice.value.isNil) {
            Error(voice.key ++ ".scd did not load, see the error above").throw;
        };
    };

    ~setupSwells.();
    ~setupLowPlucks.();
    ~setupPlucks.();
    ~setupClicks.();
    ~setupSweeps.();
    ~setupBass.();
    ~setupPercussion.();

    ~masterSynth = Synth(\masterOut, [
        \in, ~masterBus,
        \out, 0,
        \gain, 1.0,
        \ceiling, 0.8,
        \limiterDur, 0.01
    ], ~masterGroup);

    // swells <-> lowPlucks alternate, mutually exclusive, 5-20 min per leg.
    // Both spawners are driven by symbol. Each setup auto-starts its spawner,
    // so we stop lowPlucks first to begin on swells.
    // Leaving lowPlucks we ramp its feedback to 0 (over 2s) so a mid-bloom
    // switch doesn't leave the delay droning underneath swells.
    // The feedback resets go through ~spawn like the spawner's own feedback
    // moves, so they are stamped in order: unstamped, a reset could land
    // before a bloom the spawner had already scheduled and leave it droning.
    Tdef(\swellLowPluckSwitch, {
        Tdef(\lowPluckSpawner).stop;
        ~spawn.(\switch, { ~lowPluckFxSynth.set(\fb, 0, \fbLag, 2) });
        Tdef(\swellSpawner).play;
        loop {
            (rrand(5.0, 20.0) * 60).wait;       // swells leg
            Tdef(\swellSpawner).stop;
            Tdef(\lowPluckSpawner).play;
            (rrand(5.0, 20.0) * 60).wait;       // lowPlucks leg
            Tdef(\lowPluckSpawner).stop;
            ~spawn.(\switch, { ~lowPluckFxSynth.set(\fb, 0, \fbLag, 2) });
            Tdef(\swellSpawner).play;
        }
    }).play;

    "[piece] all elements running".postln;
    // run.sh waits for this file. sclang stays up when the piece fails to
    // load, so the process being alive says nothing about the piece.
    File.use("/tmp/gs-piece-ready", "w", { |f| f.write("ready\n") });
});
)
