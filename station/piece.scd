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

    // Slow drift. Over hours the pitched voices move a little lower or
    // higher, and every voice gets a little rarer or denser, each on its own
    // cycle, so the station three hours from now is not the station now.
    // Nothing new is played: the voices read these when they pick a pitch or
    // a wait. Each value wanders between -1 and 1 as the sum of two sines
    // with unrelated periods, the longer one given below in minutes.
    ~wanderOffset = rrand(0.0, 10000.0);  // a different place in the cycles on every start
    ~wander = { |minutes, phase|
        var t = (Main.elapsedTime / 60) + ~wanderOffset;
        (sin((2pi * t / minutes) + phase) * 0.65)
            + (sin((2pi * t / (minutes * 0.382)) + (phase * 1.7)) * 0.35)
    };
    // voice -> [cycle in minutes, how far it moves in octaves either way]
    ~registers = (
        swells: [173, 0.35], plucks: [131, 0.3], lowPlucks: [149, 0.25]
    );
    // voice -> [cycle in minutes, shortest and longest multiple of its waits]
    ~paces = (
        swells: [97, 0.8, 1.5], plucks: [61, 0.6, 1.6], clicks: [113, 0.6, 1.5],
        sweeps: [71, 0.6, 1.6], bass: [191, 0.7, 1.5]
    );
    // What a voice multiplies its frequencies by, and its waits by.
    ~register = { |voice|
        var r = ~registers[voice];
        2 ** (~wander.(r[0], voice.hash % 97) * r[1])
    };
    ~pace = { |voice|
        var p = ~paces[voice];
        ~wander.(p[0], (voice.hash % 89) + 40).linexp(-1, 1, p[1], p[2])
    };

    // Places a mono signal in the stereo field without making it louder:
    // the side it moves away from is turned down, the other is left alone.
    // The pitched voices used to be identical in both channels.
    ~place = { |sig, pan| [sig * (1 - pan.max(0)), sig * (1 + pan.min(0))] };

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
    ~maxChordPower = 2.5;

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
        var floor, keep, power;
        if((n > 0) and: { msg != ~lastCompoundMsg }) {
            ~lastCompoundMsg = msg;
            floor = amps.maxItem * ~peakFloor;
            keep = (0..(n - 1)).select { |i| amps[i] >= floor };
            if(keep.size > ~maxPeaks) {
                // strongest first, then back into their original order
                keep = keep.sort { |a, b| amps[a] > amps[b] }.keep(~maxPeaks).sort;
            };
            freqs = freqs[keep];
            amps = amps[keep];
            // A chord is one sine per peak, so its power is the sum of the
            // squared amplitudes. Rendered alone, the swells play 2 dB above
            // single notes for a sparse spectrum (power 1.1), 4 dB for a
            // typical one (2.4) and 11 dB for one with 32 strong peaks (14).
            // Spectra up to the typical level are left exactly as they are;
            // denser ones are scaled down to it.
            power = amps.squared.sum;
            if(power > ~maxChordPower) {
                amps = amps * (~maxChordPower / power).sqrt;
            };
            ~currentCompound = (
                name: name,
                accession: accession,
                algorithm: algorithm,
                freqs: freqs,
                amps: amps
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

    // Where the drift is, for the log, every half hour.
    Tdef(\weatherReport, {
        loop {
            ("[weather] register: "
                ++ ~registers.keys.asArray.sort.collect({ |v|
                    v ++ " x" ++ ~register.(v).round(0.01)
                }).join(", ")
                ++ " | waits: "
                ++ ~paces.keys.asArray.sort.collect({ |v|
                    v ++ " x" ++ ~pace.(v).round(0.01)
                }).join(", ")).postln;
            1800.wait;
        }
    }).play;

    "[piece] all elements running".postln;
    // run.sh waits for this file. sclang stays up when the piece fails to
    // load, so the process being alive says nothing about the piece.
    File.use("/tmp/gs-piece-ready", "w", { |f| f.write("ready\n") });
});
)
