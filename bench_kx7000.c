/* KX-7000 算力实测：内存带宽 + AVX2 FMA 浮点 + int8 点积
 * 编译: gcc -O3 -mavx2 -mfma -mf16c -fopenmp -o bench bench_kx7000.c -lm
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <immintrin.h>
#ifdef _OPENMP
#include <omp.h>
#endif

static double now(void){ struct timespec ts; clock_gettime(CLOCK_MONOTONIC,&ts); return ts.tv_sec+ts.tv_nsec*1e-9; }

/* ---------- 内存带宽 ---------- */
static void bench_mem(size_t n /*floats per array*/){
    float *a=aligned_alloc(64,n*sizeof(float));
    float *b=aligned_alloc(64,n*sizeof(float));
    float *c=aligned_alloc(64,n*sizeof(float));
    if(!a||!b||!c){printf("mem alloc fail\n");return;}
    for(size_t i=0;i<n;i++){a[i]=1.0f;b[i]=2.0f;c[i]=3.0f;}
    double t0,t1; float s=1.5f;
    /* copy: 读1写1 */
    t0=now();
    for(int r=0;r<5;r++) memcpy(a,b,n*sizeof(float));
    t1=now();
    double copy_gb = (double)n*sizeof(float)*2.0*5/(t1-t0)/1e9;
    /* triad: 读2写1 */
    t0=now();
    #pragma omp parallel for
    for(size_t i=0;i<n;i++) a[i]=b[i]+s*c[i];
    t1=now();
    double tri_gb = (double)n*sizeof(float)*3.0/(t1-t0)/1e9;
    /* 再跑一次 triad 用稳态时间 */
    double best=1e9;
    for(int r=0;r<3;r++){
        t0=now();
        #pragma omp parallel for
        for(size_t i=0;i<n;i++) a[i]=b[i]+s*c[i];
        t1=now();
        if(t1-t0<best) best=t1-t0;
    }
    tri_gb = (double)n*sizeof(float)*3.0/best/1e9;
    printf("[内存] 数组 %.0f MB x3, 线程=%d\n", (double)n*4/1048576.0,
#ifdef _OPENMP
        omp_get_max_threads()
#else
        1
#endif
    );
    printf("[内存] memcpy 带宽      : %7.2f GB/s\n", copy_gb);
    printf("[内存] triad  带宽      : %7.2f GB/s\n", tri_gb);
    free(a);free(b);free(c);
}

/* ---------- FP32 FMA ---------- */
static double bench_fma(int threads){
    const size_t N = 1<<22;
    float *x=aligned_alloc(64,N*sizeof(float));
    for(size_t i=0;i<N;i++) x[i]=1.0f+i*1e-9f;
    double t0=now();
    #pragma omp parallel num_threads(threads)
    {
        __m256 a0=_mm256_set1_ps(1.000001f),a1=a0,a2=a0,a3=a0;
        __m256 b0=_mm256_set1_ps(1e-9f);
        #pragma omp for
        for(size_t i=0;i<N;i+=8){
            __m256 v=_mm256_load_ps(x+i);
            a0=_mm256_fmadd_ps(v,b0,a0);
            a1=_mm256_fmadd_ps(v,b0,a1);
            a2=_mm256_fmadd_ps(v,b0,a2);
            a3=_mm256_fmadd_ps(v,b0,a3);
        }
        float sink[8];
        _mm256_storeu_ps(sink,_mm256_add_ps(_mm256_add_ps(a0,a1),_mm256_add_ps(a2,a3)));
        if(sink[0]==-1.0f) printf("x");
    }
    double t1=now();
    free(x);
    double flops = (double)N*4.0*2.0*8.0 /*4 fma per 8 floats, 8 lanes, 2 flop*/ /(t1-t0)/1e9;
    return flops;
}

/* ---------- int8 点积 (AVX2 maddubs+madd, llama.cpp Q4/Q8 走这条) ---------- */
static double bench_i8(int threads){
    const size_t N = 1<<24; /* bytes */
    int8_t *x=aligned_alloc(64,N), *y=aligned_alloc(64,N);
    for(size_t i=0;i<N;i++){x[i]=(int8_t)(i%7);y[i]=(int8_t)(i%5);}
    int32_t acc=0;
    double t0=now();
    #pragma omp parallel num_threads(threads)
    {
        __m256i s=_mm256_setzero_si256();
        #pragma omp for reduction(+:acc)
        for(size_t i=0;i<N;i+=32){
            __m256i vx=_mm256_load_si256((__m256i*)(x+i));
            __m256i vy=_mm256_load_si256((__m256i*)(y+i));
            __m256i p=_mm256_maddubs_epi16(_mm256_sign_epi8(vx,vx),_mm256_sign_epi8(vy,vy));
            s=_mm256_add_epi32(s,_mm256_madd_epi16(p,_mm256_set1_epi16(1)));
        }
        int32_t tmp[8]; _mm256_storeu_si256((__m256i*)tmp,s);
        for(int k=0;k<8;k++) acc+=tmp[k];
    }
    double t1=now();
    free(x);free(y);
    double gops=(double)N*2.0/(t1-t0)/1e9; /* 每 byte 一次乘加 */
    if(acc==12345678) printf("");
    return gops;
}

int main(void){
    printf("=========== KX-7000 实测 ===========\n");
    printf("CPU: ZHAOXIN KaiXian KX-7000, 8C/8T, 最大 3.5GHz\n\n");
    printf("[FP32] AVX2 FMA (1 线程): %7.2f GFLOPS\n", bench_fma(1));
    printf("[FP32] AVX2 FMA (8 线程): %7.2f GFLOPS\n", bench_fma(8));
    printf("[INT8] AVX2 maddubs (1 线程): %7.2f GOPS\n", bench_i8(1));
    printf("[INT8] AVX2 maddubs (8 线程): %7.2f GOPS\n", bench_i8(8));
    printf("\n");
    bench_mem((size_t)256*1024*1024/4); /* 256MB per array, 3 arrays = 768MB */
    return 0;
}
