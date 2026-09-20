/* 精测：只读带宽（决定 decode 速度）、大数组 memcpy、L1 内计算峰值 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <immintrin.h>
#include <omp.h>

static double now(void){ struct timespec ts; clock_gettime(CLOCK_MONOTONIC,&ts); return ts.tv_sec+ts.tv_nsec*1e-9; }

int main(void){
    size_t n = (size_t)512*1024*1024/4; /* 512MB per array */
    float *a=aligned_alloc(64,n*4), *b=aligned_alloc(64,n*4), *c=aligned_alloc(64,n*4);
    for(size_t i=0;i<n;i++){a[i]=1.0f;b[i]=2.0f;c[i]=3.0f;}

    /* ---- 只读带宽：8 线程 AVX2 累加，流式 ---- */
    for(int warm=0;warm<1;warm++){
        double t0=now();
        __m256 s0=_mm256_setzero_ps(),s1=s0,s2=s0,s3=s0;
        #pragma omp parallel for
        for(size_t i=0;i<n;i+=32){
            s0=_mm256_add_ps(s0,_mm256_load_ps(a+i));
            s1=_mm256_add_ps(s1,_mm256_load_ps(a+i+8));
            s2=_mm256_add_ps(s2,_mm256_load_ps(a+i+16));
            s3=_mm256_add_ps(s3,_mm256_load_ps(a+i+24));
        }
        double t1=now();
        float sk[8]; _mm256_storeu_ps(sk,_mm256_add_ps(_mm256_add_ps(s0,s1),_mm256_add_ps(s2,s3)));
        printf("[只读带宽 8线程 512MB] : %6.2f GB/s  (sink %.1f)\n",(double)n*4/(t1-t0)/1e9,(double)sk[0]);
    }
    /* 单线程只读 */
    {
        double t0=now();
        __m256 s0=_mm256_setzero_ps(),s1=s0,s2=s0,s3=s0;
        for(size_t i=0;i<n;i+=32){
            s0=_mm256_add_ps(s0,_mm256_load_ps(a+i));
            s1=_mm256_add_ps(s1,_mm256_load_ps(a+i+8));
            s2=_mm256_add_ps(s2,_mm256_load_ps(a+i+16));
            s3=_mm256_add_ps(s3,_mm256_load_ps(a+i+24));
        }
        double t1=now();
        float sk[8]; _mm256_storeu_ps(sk,_mm256_add_ps(_mm256_add_ps(s0,s1),_mm256_add_ps(s2,s3)));
        printf("[只读带宽 1线程 512MB] : %6.2f GB/s  (sink %.1f)\n",(double)n*4/(t1-t0)/1e9,(double)sk[0]);
    }
    /* ---- 512MB memcpy / triad ---- */
    {
        double best=1e9;
        for(int r=0;r<3;r++){double t0=now();memcpy(a,b,n*4);double t1=now();if(t1-t0<best)best=t1-t0;}
        printf("[memcpy 512MB R+W]     : %6.2f GB/s\n",(double)n*4*2/best/1e9);
        float s=1.5f; best=1e9;
        for(int r=0;r<3;r++){double t0=now();
            #pragma omp parallel for
            for(size_t i=0;i<n;i++) a[i]=b[i]+s*c[i];
            double t1=now(); if(t1-t0<best)best=t1-t0;}
        printf("[triad 512MB R2W1]     : %6.2f GB/s\n",(double)n*4*3/best/1e9);
    }

    /* ---- L1 内 FP32 FMA 峰值（真实计算峰值） ---- */
    {
        float x[1024] __attribute__((aligned(64)));
        for(int i=0;i<1024;i++) x[i]=1.0f+i*1e-9f;
        int iters=200000;
        for(int th=1; th<=8; th*=8){
            double t0=now();
            #pragma omp parallel num_threads(th)
            {
                __m256 a0=_mm256_set1_ps(1.0000001f),a1=a0,a2=a0,a3=a0;
                __m256 bb=_mm256_set1_ps(1e-12f);
                for(int it=0;it<iters;it++)
                #pragma omp simd
                for(int i=0;i<1024;i+=8){
                    __m256 v=_mm256_load_ps(x+i);
                    a0=_mm256_fmadd_ps(v,bb,a0);
                    a1=_mm256_fmadd_ps(v,bb,a1);
                    a2=_mm256_fmadd_ps(v,bb,a2);
                    a3=_mm256_fmadd_ps(v,bb,a3);
                }
                float sk[8]; _mm256_storeu_ps(sk,_mm256_add_ps(_mm256_add_ps(a0,a1),_mm256_add_ps(a2,a3)));
                if(sk[0]==-1) printf("x");
            }
            double t1=now();
            double fl = (double)iters*(1024/8)*4*8*2*th/(t1-t0)/1e9;
            printf("[FP32 FMA L1 %d线程]    : %6.2f GFLOPS\n",th,fl);
        }
    }
    /* ---- L1 内 int8 maddubs（llama.cpp Q4/Q8 路径） ---- */
    {
        int8_t x[4096] __attribute__((aligned(64))), y[4096] __attribute__((aligned(64)));
        for(int i=0;i<4096;i++){x[i]=(int8_t)(i%7);y[i]=(int8_t)(i%5);}
        int iters=200000;
        int32_t acc=0;
        double t0=now();
        #pragma omp parallel num_threads(8)
        {
            __m256i s=_mm256_setzero_si256();
            for(int it=0;it<iters;it++)
            for(int i=0;i<4096;i+=32){
                __m256i vx=_mm256_load_si256((__m256i*)(x+i));
                __m256i vy=_mm256_load_si256((__m256i*)(y+i));
                __m256i p=_mm256_maddubs_epi16(_mm256_sign_epi8(vx,vx),_mm256_sign_epi8(vy,vy));
                s=_mm256_add_epi32(s,_mm256_madd_epi16(p,_mm256_set1_epi16(1)));
            }
            int32_t t[8]; _mm256_storeu_si256((__m256i*)t,s);
            #pragma omp atomic
            acc+=t[0];
        }
        double t1=now();
        printf("[INT8 maddubs 8线程 L1] : %6.2f GOPS (acc %d)\n",(double)iters*4096*2/(t1-t0)/1e9,acc);
    }
    return 0;
}
