export interface SupabaseConfig {
    readonly jwtSecret: string;
}
export declare function createSupabaseVerifier(config: SupabaseConfig): {
    verify(token: string): Promise<{
        issuer: string;
        subject: string;
    }>;
};
//# sourceMappingURL=supabase.d.ts.map