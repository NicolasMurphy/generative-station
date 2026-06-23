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

    // 1-channel control bus carrying the kick's ducking envelope (0 = no
    // duck, 1 = full duck). Read by voices/FX to apply sidechain attenuation.
    ~sidechainBus = Bus.control(s, 1);

    // Current compound, populated by /compound OSC messages from the picker
    // sidecar. Starts nil so voices fall back to their original random ranges.
    ~currentCompound = (
        name: nil,
        accession: nil,
        algorithm: nil,
        freqs: nil,
        amps: nil
    );

    // Listen for compound updates from the picker sidecar (port 57120).
    // Message: [name, accession, algorithm, nPeaks, freq1..N, amp1..N]
    OSCdef(\compound, { |msg|
        var name = msg[1].asString;
        var accession = msg[2].asString;
        var algorithm = msg[3].asString;
        var n = msg[4].asInteger;
        var freqs = msg[(5..(4+n))];
        var amps = msg[((5+n)..(4+(2*n)))];
        ~currentCompound = (
            name: name,
            accession: accession,
            algorithm: algorithm,
            freqs: freqs,
            amps: amps
        );
        ("[piece] compound: " ++ name ++ " (" ++ n ++ " peaks)").postln;
    }, "/compound");

    (here +/+ "swells.scd").load;
    (here +/+ "lowplucks.scd").load;
    (here +/+ "plucks.scd").load;
    (here +/+ "clicks.scd").load;
    (here +/+ "sweeps.scd").load;
    (here +/+ "bass.scd").load;
    (here +/+ "kick.scd").load;

    ~setupSwells.();
    ~setupLowPlucks.();
    ~setupPlucks.();
    ~setupClicks.();
    ~setupSweeps.();
    ~setupBass.();
    ~setupKick.();

    // swells <-> lowPlucks alternate, mutually exclusive, 5-20 min per leg.
    // swells.scd is untouched — both spawners are driven by symbol. Each setup
    // auto-starts its spawner, so we stop lowPlucks first to begin on swells.
    // Leaving lowPlucks we ramp its feedback to 0 (over 2s) so a mid-bloom
    // switch doesn't leave the delay droning underneath swells.
    Tdef(\swellLowPluckSwitch, {
        Tdef(\lowPluckSpawner).stop;
        ~lowPluckFxSynth.set(\fb, 0, \fbLag, 2);
        Tdef(\swellSpawner).play;
        loop {
            (rrand(5.0, 20.0) * 60).wait;       // swells leg
            Tdef(\swellSpawner).stop;
            Tdef(\lowPluckSpawner).play;
            (rrand(5.0, 20.0) * 60).wait;       // lowPlucks leg
            Tdef(\lowPluckSpawner).stop;
            ~lowPluckFxSynth.set(\fb, 0, \fbLag, 2);
            Tdef(\swellSpawner).play;
        }
    }).play;

    "[piece] all elements running".postln;
});
)
