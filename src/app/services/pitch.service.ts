import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import * as pitchlite from 'src/app/services/pitchlite';


const worklet_chunk_size = 128;
const big_win = 4096;
const small_win = 512;
const min_pitch = 140; // lower pitch of mpm, 140 hz is close to trumpet
const use_yin = false; // use MPM by default

function scaleArrayToMinusOneToOne(array: Float32Array) {
    const maxAbsValue = Math.max(...array.map(Math.abs));
    return array.map((value) => value / maxAbsValue);
}

const audioContext = new AudioContext();
console.log("Sample rate:", audioContext.sampleRate);



@Injectable({
    providedIn: 'root'
})
export class PitchService {
    private isStopped = false;
    private accumNode!: AudioWorkletNode;
    private analyser!: AnalyserNode;
    private wasmModule: any;
    private ptr: any;
    private ptrPitches: any;
    private stream: MediaStream | undefined;
    private nAccumulated = 0;
    private n_pitches!: number;


    pitch$ = new BehaviorSubject<number>(0);

    constructor() { }

    async connect() {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.wasmModule = await pitchlite();

        this.n_pitches = this.wasmModule._pitchliteInit(
            big_win,
            small_win,
            audioContext.sampleRate, // use the actual sample rate of the audio context
            use_yin, // use yin
            min_pitch, // mpm low pitch cutoff
        );

        // Create WASM views of the buffers, do it once and reuse
        this.ptr = this.wasmModule._malloc(big_win * Float32Array.BYTES_PER_ELEMENT);
        this.ptrPitches = this.wasmModule._malloc(this.n_pitches * Float32Array.BYTES_PER_ELEMENT);


        await audioContext.audioWorklet.addModule('audio-accumulator.js');
        // Create an instance of your custom AudioWorkletNode
        this.accumNode = new AudioWorkletNode(audioContext, 'audio-accumulator', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });

        // // Connect the microphone stream to the processor
        const source = audioContext.createMediaStreamSource(this.stream);
        source.connect(this.accumNode);

        this.analyser = audioContext.createAnalyser();
        this.analyser.fftSize = 2048;

        this.accumNode.connect(this.analyser);

        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0;
        this.analyser.connect(gainNode);

        gainNode.connect(audioContext.destination);
        this.analyse();


        this.accumNode.port.onmessage = (event) => {
            // Check if the "stop" button has been clicked
            // event.data contains 128 samples of audio data from
            // the microphone through the AudioWorkletProcessor

            // scale event.data.data up to [-1, 1]
            const scaledData = scaleArrayToMinusOneToOne(event.data.data);

            // Calculate the offset in bytes based on naccumulated
            const offset = (this.nAccumulated * worklet_chunk_size) * Float32Array.BYTES_PER_ELEMENT;

            // store latest 128 samples into the WASM buffer
            this.wasmModule.HEAPF32.set(scaledData, (this.ptr + offset) / Float32Array.BYTES_PER_ELEMENT);
            this.nAccumulated += 1;

            // Check if we have enough data to calculate the pitch
            if (this.nAccumulated >= (big_win / worklet_chunk_size)) {
                this.nAccumulated = 0; // reset the accumulator

                // Call the WASM function
                this.wasmModule._pitchlitePitches(this.ptr, this.ptrPitches);

                // copy the results back into a JS array
                let wasmArrayPitches = new Float32Array(this.wasmModule.HEAPF32.buffer, this.ptrPitches, this.n_pitches);
                // Do something with the pitch
                this.pitch$.next(wasmArrayPitches[this.n_pitches - 1]);

                // clear the entire buffer
                this.wasmModule._memset(this.ptr, 0, big_win * Float32Array.BYTES_PER_ELEMENT);
            }
        };

    }

    analyse() {
        requestAnimationFrame(this.analyse.bind(this));
        const data = new Float32Array(this.analyser.frequencyBinCount);
    }





    disconnect() {
        console.log("Stopping and disconnecting and cleaning up")
        this.isStopped = true;

        // disconnect the audio worklet node
        this.accumNode?.disconnect();

        // stop tracks
        this.stream?.getTracks().forEach(function (track: any) {
            console.log('Stopping stream');
            // Here you can free the allocated memory
            track.stop();
        });

        // cleanup
        this.wasmModule._free(this.ptrPitches);
        this.wasmModule._free(this.ptr);
    }

}
