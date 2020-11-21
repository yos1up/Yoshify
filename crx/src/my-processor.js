const DOWNSAMPLING = 4 // 1 がダウンサンプリングなし．128 以下の2ベキである必要がある．

class MyProcessor extends AudioWorkletProcessor {
    constructor() {
        super()
        this.waveBuffer = new RingBuffer(Math.round(sampleRate / DOWNSAMPLING * 5)) // 5秒ぶん
        this.estimationResult = {
            "bpm": null,
            "beatReferenceTime": null
        }
        this.callCnt = 0
    }

    process(inputs, outputs, parameters) {
        this.callCnt++
        if (this.callCnt % 1000 === 0){
            const message = {
                "wave": this.waveBuffer.slice(),
                "waveFinishedAt": this.waveBuffer.updatedAt,
                "waveSampleRate": sampleRate / DOWNSAMPLING
            }
            this.port.postMessage(message)
            // TODO このメッセージを送信した瞬間一瞬ラグるのの抑止
            // この行を postMessage({}) にするとラグらないので
            // メッセージサイズがもっと小さければ良いのだが……
            // → 220500サンプルだとラグるけど45000サンプル程度だとラグらないらしいので
            // wave の samplingRate を下げて対応？
        }
        if (inputs[0][0]){
            for (let i = 0; i < inputs[0][0].length; i+=DOWNSAMPLING) this.waveBuffer.push(inputs[0][0][i])
            this.waveBuffer.updatedAt = currentTime
        }
        return true
    }
 
}
registerProcessor('my-processor', MyProcessor);


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


function argmax(ary){
    let maxi = -Infinity, argmaxi = -1
    for(let i=0;i<ary.length;i++) if (maxi < ary[i]) {maxi = ary[i]; argmaxi = i}
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

