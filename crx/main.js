

const USE_AUDIOWORKLET = true


function argmax(ary){
    let maxi = -Infinity, argmaxi = -1
    for(let i=0;i<ary.length;i++) if (maxi < ary[i]) {maxi = ary[i]; argmaxi = i}
    return argmaxi
}

function autoDownload(filename, contentString){
    download(filename, createURLFromText(contentString))
}
function createURLFromText(contentString) {
    let bom = new Uint8Array([0xef, 0xbb, 0xbf])
    let url = URL.createObjectURL(
        new Blob([bom, contentString], { type: 'text/plain;charset=UTF-8' })
    )
    return url
}
function download(filename, url){
    let a = document.createElement('a')
    document.body.appendChild(a)
    a.download = filename
    a.href = url
    a.click()
    document.body.removeChild(a)
}

const audioContext = new AudioContext()
const audioContextSampleRate = audioContext.sampleRate

const soundBuffers = {}
function loadSound(url, name) {
    let request = new XMLHttpRequest();
    request.open('GET', url, true);
    request.responseType = 'arraybuffer'
    // Decode asynchronously
    request.onload = function() {
        audioContext.decodeAudioData(request.response, function(buffer) {
            soundBuffers[name] = buffer
        }, ()=>{console.log("decode failed")})
    }
    request.send()
}
// loadSound("http://commons.nicovideo.jp/api/preview/get?cid=104869", "tick")
loadSound(chrome.extension.getURL("metronome.wav"), "tick")

function playSound(buffer, when) {
    /* デコード済音声バイナリデータ buffer を when[sec]（AudioContextのcurrentTimeなどで扱われる絶対時間）に再生する */
    let source = audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(audioContext.destination)
    source.start(when)
}

class RingBuffer{
    constructor(capacity){
        this.data = new Array(capacity)
        this.capacity = capacity
        this.length = 0
        this.start = 0
        this.end = 0
        this.updatedAt = null
    }
    push(x){
        this.data[this.end] = x
        if (this.length > 0 && this.start == this.end) this.start = (this.start + 1) % this.capacity
        this.end = (this.end + 1) % this.capacity
        this.length = Math.min(this.length + 1, this.capacity)
    }
    slice(s, e){
        if (typeof s === "undefined") s = 0
        if (typeof e === "undefined") e = this.length
        e = Math.min(e, this.length)
        s = Math.max(0, Math.min(s, e))
        const n = e - s
        s = (s + this.start) % this.capacity
        if (s + n <= this.length) return this.data.slice(s, s + n)
        return this.data.slice(s).concat(this.data.slice(0, n - this.length + s))
    }
}
const waveBuffer = new RingBuffer(audioContextSampleRate * 5)

// ScriptProcessorNode を用いる方針（非推奨，いずれは AudioWorklet へ移行が必要らしいが）
// TODO: 16384設定（最大）でもSPNはかなり重い
// AudioWorklet へ移行すべきか．あるいは destination へのルートと spn へのルートを並列にできないか？
const binWidthBySample = 16384

let vs = document.getElementsByTagName("video")
if (vs.length > 0){
    const track = audioContext.createMediaElementSource(vs[0])
    if (!USE_AUDIOWORKLET){
        const spn = audioContext.createScriptProcessor(binWidthBySample, 1, 1)
        // 生波形をバッファに貯めていく
        spn.onaudioprocess = function(e) {
            var inputBuffer = e.inputBuffer
            var outputBuffer = e.outputBuffer
            for (var channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
                var inputData = inputBuffer.getChannelData(channel);
                var outputData = outputBuffer.getChannelData(channel);
                for (var sample = 0; sample < inputBuffer.length; sample++) {
                    outputData[sample] = inputData[sample];
                    if (channel==0) waveBuffer.push(inputData[sample])
                    // TODO: 片方チャンネルのみになってる
                }
            }
            waveBuffer.updatedAt = audioContext.currentTime
        }
        track.connect(spn)
        spn.connect(audioContext.destination)
    }else{
        /*
        const processorSource = `
            class MyProcessor extends AudioWorkletProcessor {
                constructor() {
                    super();
                }
                process(inputs, outputs, parameters) {
                    // let input = inputs[0];
                    // let output = outputs[0];
                    // for (let channel = 0; channel < input.length; ++channel) {
                    //     let inputChannel = input[channel];
                    //     let outputChannel = output[channel];
                    //     for (let i = 0; i < inputChannel.length; ++i) outputChannel[i] = inputChannel[i]
                    // }
                    if (Math.random() < 0.01) console.log(":)")
                    return true;
                }
            }
            registerProcessor('my-processor', MyProcessor);
        `        
        // addModule できるのはローカルファイルではだめでサーバーからの提供である必要があるらしいので Blob を生成する
        // 参考：https://stackoverflow.com/questions/52760219/use-audioworklet-within-electron-domexception-the-user-aborted-a-request
        const processorBlob = new Blob([processorSource], { type: 'text/javascript' });
        const processorPath = URL.createObjectURL(processorBlob);
        */
        const processorPath = chrome.extension.getURL("my-processor.js")
        audioContext.audioWorklet.addModule(processorPath).then(() => {
            const awn = new AudioWorkletNode(audioContext, "my-processor")
            track.connect(awn)
            // awn は destination に繋がなくても動作してくれるようだ．素敵．
            track.connect(audioContext.destination)

            setInterval(()=>{
                awn.port.postMessage({})
            }, 3000)
        })
    }
}


function computeBPM(){
    const wave = waveBuffer.slice()
    const waveFinishedAt = waveBuffer.updatedAt
    if (wave.length === 0 || wave.reduce((x,y)=>x+y) === 0){
        estimationResult.bpm = null
        estimationResult.beatReferenceTime = null
        return null
    }
    worker.postMessage({audioContextSampleRate, wave, waveFinishedAt}) // WebWorker に移動したおかげで FFT が原因でメインスレッドの処理落ちすることはなくなった
}

console.log("start computing BPM")
setInterval(computeBPM, 4000)


const workerJS = `
    function computeBPM(data){
        const {audioContextSampleRate, wave, waveFinishedAt} = data
        // 1. STFTする
        // 2. 発音タイミングを抽出する
        // 3. その時間挙動を FFT する
        const binSample = 1024
        const stfts = []
        for(let i=0;i<wave.length;i+=binSample){
            let wavelet = wave.slice(i, i + binSample)
            wavelet = padZero(wavelet, binSample)
            stfts.push(getPower(fft1(wavelet)))
        }
        // 2
        const lpFreq = 200, hpFreq = 50000 // 低音域と高音域だけあてにする
        const filteredIndices = [...Array(binSample).keys()].filter(i => i/binSample * audioContextSampleRate < lpFreq || hpFreq < i/binSample * audioContextSampleRate)
        const onSignal = [...Array(stfts.length - 1).keys()].map(i => filteredIndices.map(j => Math.max(stfts[i+1][j] - stfts[i][j], 0)).reduce((x,y) => x + y))
        const onSignalSamplingRate = audioContextSampleRate / binSample
        // 3
        const onSignalPadded = padZero(onSignal, 32768)
        const onSpect = fft1(onSignalPadded)
        const onPowerSpect = getPower(onSpect)
        const indexToBPMCoeff = 60 * audioContextSampleRate / onSignalPadded.length / binSample

        const peakIndex = findPeak(onPowerSpect, Math.floor(50 / indexToBPMCoeff), Math.ceil(200 / indexToBPMCoeff))
        const bpmCandidates = peakIndex.map(i => ({
            "BPM": indexToBPMCoeff * i,
            "peakValue": onPowerSpect[i],
            "curvature": onPowerSpect[i] - 0.5 * (onPowerSpect[i-1] + onPowerSpect[i+1])
        }))
        return {bpmCandidates, onSignal, onSignalSamplingRate, waveFinishedAt, onPowerSpect, wave}
    }

    function findPeak(ary, start, end){
        start = Math.max(0, start)
        end = Math.min(ary.length, end)
        let ret = null, maxi = -Infinity
        for(let i=start;i<end;i++){
            if (maxi < ary[i]) {
                maxi = ary[i]
                ret = i
            }
        }
        let ret2 = []
        for(let i=start;i<end;i++){
            if (0 < i && i + 1 < ary.length && ary[i-1] <= ary[i] && ary[i] >= ary[i+1]) ret2.push(i)
        }
        return ret2
    }

    // ====================== FFT ======================
    // https://qiita.com/bellbind/items/ba7aa07f6c915d400000
    function expi(theta) {return [Math.cos(theta), Math.sin(theta)];}
    function iadd([ax, ay], [bx, by]) {return [ax + bx, ay + by];}
    function isub([ax, ay], [bx, by]) {return [ax - bx, ay - by];}
    function imul([ax, ay], [bx, by]) {return [ax * bx - ay * by, ax * by + ay * bx];}
    function isum(cs) {return cs.reduce((s, c) => iadd(s, c), [0, 0]);}
    function revBit(k, n) {
        let r = 0;
        for (let i = 0; i < k; i++) r = (r << 1) | ((n >>> i) & 1);
        return r;
    }
    function fftin1(c, T, N) {
        const k = Math.log2(N);
        const rec = c.map((_, i) => c[revBit(k, i)]);
        for (let Nh = 1; Nh < N; Nh *= 2) {
            T /= 2;
            for (let s = 0; s < N; s += Nh * 2) {
                for (let i = 0; i < Nh; i++) {
                    const l = rec[s + i], re = imul(rec[s + i + Nh], expi(T * i));
                    [rec[s + i], rec[s + i + Nh]] = [iadd(l, re), isub(l, re)];
                }
            }
        }
        return rec;
    }
    function fft1(f) {
        /* [[re, im], ...] => [[re, im], ...] array length must be power of 2 */
        f = f.map(e => (typeof e[0] === "undefined") ? [e, 0] : e) // 実数は複素数に
        const N = f.length, T = -2 * Math.PI;
        return fftin1(f, T, N);
    }
    function ifft1(F) {
        /* [[re, im], ...] => [[re, im], ...] array length must be power of 2 */
        F = F.map(e => (typeof e[0] === "undefined") ? [e, 0] : e) // 実数は複素数に
        const N = F.length, T = 2 * Math.PI;
        return fftin1(F, T, N).map(([r, i]) => [r / N, i / N]);
    }
    function padZero(ary, len){
        if (typeof len === "undefined"){
            len = 1
            while(len < ary.length) len <<= 1
        }
        return ary.concat(Array(len - ary.length).fill(0))
    }
    function getPower(cplxAry){
        return cplxAry.map(e => e[0]*e[0] + e[1]*e[1])
    }
    // ====================== FFT ======================

    onmessage = function(e) {postMessage(computeBPM(e.data))}
`

let estimationResult = {
    "bpm": null,
    "beatReferenceTime": null
}

const worker = new Worker(createURLFromText(workerJS))
worker.onmessage = function (e){
    const {bpmCandidates, onSignal, onSignalSamplingRate, waveFinishedAt, onPowerSpect, wave} = e.data
    if (bpmCandidates.length > 0) {
        const argmaxi = argmax(bpmCandidates.map(_ => _.peakValue))
        const bpm = bpmCandidates[argmaxi].BPM
        console.log("estimated BPM: " + bpm)
        // const argmaxi2 = argmax(bpmCandidates.map(_ => _.curvature/_.peakValue))
        // console.log(bpmCandidates[argmaxi2].BPM)

        //拍タイミング推定
        const peakOffset = findPeakOffset(onSignal, onSignalSamplingRate * 60 / bpm)
        const beatReferenceTime = waveFinishedAt - (onSignal.length - peakOffset) / onSignalSamplingRate

        estimationResult.bpm = bpm
        estimationResult.beatReferenceTime = beatReferenceTime

        // autoDownload("onPowerSpect.txt", String(onPowerSpect))
        // autoDownload("wave.txt", String(wave))
    }
}

// メトロノーム用
let lastScheduledTime = null
function setMetronomeSchedule(){
    // 400ms 先までのメトロノームを登録する
    const {bpm, beatReferenceTime} = estimationResult
    if (bpm === null) return
    if (beatReferenceTime === null) return
    const beatIntervalTime = 60 / bpm
    // audioContext.currentTime 以降 400ms の間で，beatReferenceTime + i * beatIntervalTime と表されるもののうち
    // lastScheduledTime 以降であるものを登録する．
    const currentTime = audioContext.currentTime
    const seq = generateTrimmedArithmeticSequence(
        beatReferenceTime,
        beatIntervalTime,
        currentTime,
        currentTime + 0.4
    ).filter(_ => (lastScheduledTime === null) || (lastScheduledTime + 0.2 < _))
    for (let s of seq){
        playSound(soundBuffers.tick, s)
        // TODO: 周辺の 0.15 はヒューリスティックに入れた調整
    }
    if (seq.length > 0) lastScheduledTime = Math.max(...seq)
}
setInterval(setMetronomeSchedule, 250)

function findPeakOffset(ary, interval){
    // ary[i + n * interval] (nは添字が有効な範囲で整数全体を動く) の平均が最大となるような i を求める．
    // ただし interval は整数とは限らない．中途半端な index に対しては ary を線形補完して計算する．
    // TODO: 遅い場合は高速化
    let maxi = -Infinity
    let argmaxi = -1
    for(let i=0;i<ary.length;i++){
        let numer = 0
        let denom = 0
        const seq = generateTrimmedArithmeticSequence(i, interval, 0, ary.length-1)
        for(let s of seq){
            const x = lerp(ary, s)
            if (x !== null){
                numer += x
                denom++
            }
        }
        const ave = numer / denom
        if (maxi < ave) {
            maxi = ave
            argmaxi = i
        }
    }
    return argmaxi
}

function lerp(ary, i){
    if (i < 0 || ary.length - 1 < i) return null
    if (i == ary.length - 1) return ary[ary.length - 1]
    const n = Math.floor(i)
    const r = i - n
    return ary[n] * (1 - r) + ary[n+1] * r
}

function generateTrimmedArithmeticSequence(ref, diff, mini, maxi){
    /* 無限等差数列 (ref + n * diff)_{n in Z} を区間 [mini, maxi] で切り取ったものを Array として返す
    diff は非ゼロとする．diffが正なら昇順，負なら降順のArrayが返る．*/
    if (diff < 0) return generateTrimmedArithmeticSequence(ref, -diff, mini, maxi).reverse()
    let nMin = Math.ceil((mini - ref) / diff)
    let nMax = Math.floor((maxi - ref) / diff)
    return range(nMin, nMax+1).map(_ => ref + _ * diff)
}

function range(s, e){
    /* [s, s+1, ..., e-1] */
    if (s >= e) return []
    return [...Array(e - s).keys()].map(_ => s + _)
}